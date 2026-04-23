import crypto from "node:crypto"
import path from "node:path"
import type {
  AssistantOutbound,
  AssistantOutboundKind,
  AppCfg,
  ConnState,
  FeishuApi,
  ImSession,
  InboundMessage,
  OpencodeAgent,
  OpencodeCommand,
  OpencodeEvent,
  OpencodeMcp,
  OpencodeProvider,
  OpencodeResult,
  OpencodeSkill,
  OpencodeStatus,
  OpencodeSvc,
  Render,
  RenderOut,
  SessionSvc,
  Store,
  Task,
  TaskSvc,
} from "../contracts.js"
import { cfg } from "./cfg.js"
import { createSqliteStore } from "../storage/db.js"
import { cleanupDir } from "../storage/cleanup.js"
import { createRender } from "../render/text.js"
import { createFeishuApi } from "../feishu/api.js"
import { createOpencodeSvc } from "../opencode/client.js"
import { createSessionSvc } from "../gateway/session.js"
import { createTaskSvc } from "../gateway/task.js"
import { createQueue } from "../queue/bus.js"
import { createGateway } from "../gateway/ingest.js"
import { createFeishuConn } from "../feishu/conn.js"
import { createOpencodeEvent } from "../opencode/event.js"
import { parseCmd } from "../gateway/cmd.js"
import { LOCAL_COMMANDS } from "./commands.js"
import {
  ameta,
  done_msg,
  explain,
  model,
  qmeta,
  recover_msg,
  repo,
  signal_msg,
  status_card,
  short,
  stuck,
  time,
  type RecoverMode,
} from "./text.js"
export { explain, friendly, status_text } from "./text.js"

type App = {
  cfg: AppCfg
  start(): Promise<void>
  stop(): Promise<void>
}

type Question = {
  question?: string
  options?: Array<{ label?: string }>
  custom?: boolean
}

type TaskRow = NonNullable<Awaited<ReturnType<Store["get_last_task"]>>>

type PublishKind = Extract<AssistantOutboundKind, "ack" | "progress" | "attachment" | "intermediate" | "final" | "error">

type PublishMeta = {
  kind: PublishKind
  terminal?: boolean
}

type EmitMeta = PublishMeta & {
  action: Exclude<AssistantOutbound["action"], "deferred">
  feishu_message_id?: string
}

const ack_meta = { kind: "ack" } satisfies PublishMeta
const progress_meta = { kind: "progress" } satisfies PublishMeta
const attachment_meta = { kind: "attachment" } satisfies PublishMeta
const intermediate_meta = { kind: "intermediate" } satisfies PublishMeta
const final_meta = { kind: "final", terminal: true } satisfies PublishMeta
const error_meta = { kind: "error", terminal: true } satisfies PublishMeta

type Tick = {
  chat_id: string
  out: RenderOut
  meta?: PublishMeta
}

type Progress = {
  push(session_id: string, chat_id: string, out: RenderOut, meta?: PublishMeta): Promise<void>
}

type Stream = Progress & {
  flush(session_id: string): Promise<void>
}

type WaitOutbound = AssistantOutbound & {
  kind: "approval" | "question"
}

function active(status: string) {
  return status === "queued" || status === "acked" || status === "running" || status === "waiting_permission"
}

function live(status: string) {
  return active(status) || status === "waiting_question" || status === "waiting_attachment"
}

function wait(status?: string) {
  return status === "waiting_permission" || status === "waiting_question" || status === "waiting_attachment"
}

function done(status?: string) {
  return status === "completed" || status === "failed" || status === "aborted"
}

function raw(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

async function prefs(store: Store, inbound: InboundMessage) {
  const chat = await store.get_pref({
    scope: "chat",
    tenant_id: inbound.tenant_id,
    chat_id: inbound.chat_id,
  })
  const user = await store.get_pref({
    scope: "user",
    tenant_id: inbound.tenant_id,
    user_id: inbound.user_id,
  })
  return { chat, user }
}

function local() {
  return LOCAL_COMMANDS
}

function help() {
  return [
    "可用命令：",
    ...local().map((item) => `${item.name} ${item.description}`),
    "/repo --chat 为当前聊天设置默认目录",
    "/repo --me 为当前用户设置默认目录",
    "--chat / --me 可与 --workspace 组合使用",
    "未命中的 slash 会尝试透传到 OpenCode 执行，例如 /init",
    "示例：/repo /path/to/opencode",
    "示例：/repo --chat /path/to/opencode",
    "示例：/repo --workspace ws_local",
    "示例：/repo /path/to/opencode --workspace ws_local",
    "示例：/sessions",
    "示例：/session ses_xxx",
    "示例：/agents",
    "示例：/models",
    "示例：/model provider/model",
    "示例：/model reset",
    "示例：/mcps",
    "示例：/commands",
    "示例：/init",
  ].join("\n")
}

function group(chat_type?: string) {
  return chat_type === "group" || chat_type === "group_chat"
}

function esc(val: string) {
  return val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function strip(text: string, names?: string[]) {
  const line = text.replace(/<at\b[^>]*>.*?<\/at>/gi, " ")
  const head = (names ?? []).filter(Boolean).reduce((item, name) => {
    return item.replace(new RegExp(`^\\s*@${esc(name)}\\s*`), "")
  }, line)
  return head.replace(/^(\s*@\S+\s*)+/, "").trim()
}

export function body(msg: InboundMessage) {
  const val = group(msg.chat_type) ? strip(msg.text, msg.mention_names) : msg.text
  return val.trim()
}

function count(list: InboundMessage["assets"]) {
  const image = list.filter((item) => item.kind === "image").length
  const file = list.length - image
  return [image ? `${image} 张图片` : "", file ? `${file} 个文件` : ""].filter(Boolean).join("，")
}

function note(text: string, assets: InboundMessage["assets"]) {
  if (assets.length === 0) return text
  const head = count(assets)
  if (!text) return `已收到 ${head}`
  return `${text}\n\n已附：${head}`
}

export function holdmsg(assets: InboundMessage["assets"]) {
  return `已收到 ${count(assets)}，请再发一句你希望我做什么。我会把这些附件和你的说明一起处理。`
}

export function moremsg(add: InboundMessage["assets"], all: InboundMessage["assets"]) {
  return `又收到 ${count(add)}，当前累计 ${count(all)}，请再发一句你希望我做什么。`
}

function item(item: InboundMessage["assets"][number], i: number) {
  const kind = item.kind === "image" ? "图片" : "文件"
  const name = item.name?.trim()
  if (!name) return `${i + 1}. ${kind}`
  return `${i + 1}. ${kind} ${name}`
}

function list(assets: InboundMessage["assets"]) {
  if (assets.length === 0) return ""
  const head = assets.slice(0, 6).map(item).join("\n")
  if (assets.length <= 6) return head
  return `${head}\n其余 ${assets.length - 6} 个附件略`
}

export function guide(text: string, assets: InboundMessage["assets"]) {
  const val = text.trim()
  if (!val || assets.length === 0) return val
  return [
    "请直接基于本条消息附带的附件回答或执行，不要把内部工具调用、读取过程、本地缓存路径或系统注入文本当作最终答案的一部分。",
    `附件概览：${count(assets)}`,
    `附件顺序：\n${list(assets)}`,
    "如果用户提到“这张 / 这几张 / 第 N 个附件 / 这些文件”，请优先按上面的附件顺序理解。",
    `用户要求：${val}`,
  ].join("\n\n")
}

export function permit(text: string) {
  const list = index(text)
  if (list?.length === 1) {
    if (list[0] === 1) return "once" as const
    if (list[0] === 2) return "always" as const
    if (list[0] === 3) return "reject" as const
  }
}

function index(text: string) {
  const val = text.trim()
  if (!val) return
  if (!/^[\d\s,，、.。()（）]+$/.test(val)) return
  const list = val
    .split(/[^\d]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)
  if (list.length === 0) return
  return [...new Set(list)]
}

function qnote(input: { title: string; opts: string[]; custom: boolean }) {
  return `question:${input.custom ? "1" : "0"}:${encodeURIComponent(input.title)}:${input.opts.map(encodeURIComponent).join("|")}`
}

function anote(input: { tool: string; detail: string }) {
  return `approval:${encodeURIComponent(input.tool)}:${encodeURIComponent(input.detail)}`
}

export function pick(text: string, opts: string[]) {
  if (opts.length === 0) return
  const ids = index(text)
  if (ids) {
    const list = ids.map((item) => opts.at(item - 1)).filter((item): item is string => !!item)
    if (list.length === ids.length) return [...new Set(list)]
  }
}

function parts(text: string, assets: InboundMessage["assets"]) {
  const list = assets.filter((item): item is typeof item & { url: string; mime: string; name: string } => !!item.url && !!item.mime && !!item.name)
  const val = guide(text, assets)
  return [
    ...(val ? [{ type: "text" as const, text: val }] : []),
    ...list.map((item) => ({
      type: "file" as const,
      url: item.url,
      mime: item.mime,
      filename: item.name,
    })),
  ]
}

function ready(assets: InboundMessage["assets"]) {
  return assets.filter((item): item is typeof item & { url: string; mime: string; name: string } => !!item.url && !!item.mime && !!item.name)
}


function record(val: unknown) {
  if (!val || typeof val !== "object") return
  return val as Record<string, unknown>
}

function wait_outbound(item: AssistantOutbound): item is WaitOutbound {
  return item.kind === "approval" || item.kind === "question"
}

function approval_meta(payload: unknown) {
  const val = record(payload)
  return {
    tool: typeof val?.tool === "string" ? val.tool : "tool",
    detail: typeof val?.detail === "string" ? val.detail : "",
  }
}

function question_meta(payload: unknown) {
  const val = record(payload)
  return {
    title: typeof val?.title === "string" ? val.title : "请补充信息",
    opts: Array.isArray(val?.opts) ? val.opts.filter((item): item is string => typeof item === "string") : [],
    custom: typeof val?.custom === "boolean" ? val.custom : true,
  }
}

function wait_req_type(kind: WaitOutbound["kind"]) {
  return kind === "approval" ? ("permission" as const) : ("question" as const)
}

function wait_status(kind: WaitOutbound["kind"]) {
  return kind === "approval" ? ("waiting_permission" as const) : ("waiting_question" as const)
}

function wait_note(item: WaitOutbound) {
  if (item.kind === "approval") {
    const meta = approval_meta(item.payload)
    return anote(meta)
  }
  const meta = question_meta(item.payload)
  return qnote(meta)
}

async function live_task(store: Store, session_id: string) {
  const list = await store.list_tasks({ session_id })
  return [...list].reverse().find((item) => !done(item.status)) ?? null
}

async function open_waits(store: Store, task_id: string) {
  return (await store.list_open_waits(task_id)).filter(wait_outbound)
}

async function head_wait(store: Store, row: Task | null | undefined) {
  if (!row) return null
  return (await open_waits(store, row.id))[0] ?? null
}

async function sync_wait_head(store: Store, row: Task, item: WaitOutbound | null) {
  const current = (await store.get_task(row.id)) ?? row
  if (done(current.status)) return current

  if (!item) {
    const next = {
      ...current,
      status:
        current.status === "waiting_permission" || current.status === "waiting_question"
          ? ("running" as const)
          : current.status,
      req_type: current.status === "waiting_attachment" ? current.req_type : undefined,
      req_id: undefined,
      req: undefined,
      updated_at: Date.now(),
    } satisfies Task
    if (
      next.status === current.status &&
      next.req_type === current.req_type &&
      next.req_id === current.req_id &&
      next.req === current.req
    ) {
      return current
    }
    await store.save_task(next)
    return next
  }

  const req = item.req_key ?? current.req ?? undefined
  const next = {
    ...current,
    status: wait_status(item.kind),
    req_type: wait_req_type(item.kind),
    req_id: req,
    req,
    note: wait_note(item),
    updated_at: Date.now(),
  } satisfies Task
  if (
    next.status === current.status &&
    next.req_type === current.req_type &&
    next.req_id === current.req_id &&
    next.req === current.req &&
    next.note === current.note
  ) {
    return current
  }
  await store.save_task(next)
  return next
}

async function queue_wait(
  store: Store,
  row: Task,
  input: {
    kind: WaitOutbound["kind"]
    req: string
    visible: boolean
    payload: Record<string, unknown>
  },
) {
  const [history, open, inbound] = await Promise.all([
    store.list_assistant_outbounds(row.id),
    open_waits(store, row.id),
    store.get_inbound(row.inbound_id),
  ])
  const time = Date.now()
  const existing = open.find((item) => item.req_key === input.req)
  const is_head = existing ? open[0]?.id === existing.id : open.length === 0
  if (existing) {
    const next = {
      ...existing,
      payload: input.payload,
      updated_at: time,
    } satisfies AssistantOutbound
    await store.save_assistant_outbound(next)
    return {
      item: next,
      became_head: is_head,
    }
  }
  const item = {
    id: "aso_" + crypto.randomUUID(),
    task_id: row.id,
    session_id: row.session_id,
    seq: (history.at(-1)?.seq ?? 0) + 1,
    kind: input.kind,
    action: is_head && input.visible ? (row.outbound_id ? "patch" : "reply") : "deferred",
    state: "open",
    origin_inbound_id: row.inbound_id,
    origin_message_id: row.reply_anchor_message_id ?? inbound?.message_id ?? "",
    req_key: input.req,
    terminal: false,
    feishu_message_id: is_head && input.visible ? row.outbound_id : undefined,
    payload: input.payload,
    created_at: time,
    updated_at: time,
  } satisfies AssistantOutbound
  await store.save_assistant_outbound(item)
  return {
    item,
    became_head: is_head,
  }
}

async function resolve_wait(store: Store, row: Task, req: string) {
  const waits = await open_waits(store, row.id)
  const hit = waits.find((item) => item.req_key === req)
  if (hit) {
    await store.save_assistant_outbound({
      ...hit,
      state: "resolved",
      updated_at: Date.now(),
    })
  }
  return sync_wait_head(store, row, await head_wait(store, row))
}

async function mark_visible_wait(store: Store, row: Task) {
  const item = await head_wait(store, row)
  if (!item) return
  const current = (await store.get_task(row.id)) ?? row
  const next = {
    ...item,
    action: current.outbound_id ? "patch" : "reply",
    feishu_message_id: current.outbound_id,
    updated_at: Date.now(),
  } satisfies AssistantOutbound
  if (next.action === item.action && next.feishu_message_id === item.feishu_message_id) return
  await store.save_assistant_outbound(next)
}

function wait_out(render: Render, item: WaitOutbound) {
  if (item.kind === "approval") {
    const meta = approval_meta(item.payload)
    return render.approval({
      req: item.req_key ?? "",
      tool: meta.tool,
      detail: meta.detail,
    })
  }
  const meta = question_meta(item.payload)
  return render.question({
    req: item.req_key ?? "",
    title: meta.title,
    opts: meta.opts,
    custom: meta.custom,
  })
}

async function wait_action(store: Store, row: Task, item: WaitOutbound) {
  if (item.feishu_message_id) return "patch" as const
  if (item.action === "reply" || item.action === "patch") return item.action
  const history = (await store.list_assistant_outbounds(row.id)).filter(wait_outbound)
  const seen_wait = history.some((candidate) => candidate.seq < item.seq)
  return !seen_wait && row.outbound_id ? ("patch" as const) : ("reply" as const)
}

async function promote_wait(store: Store, row: Task, item: WaitOutbound) {
  const action = await wait_action(store, row, item)
  const next = {
    ...item,
    action,
    feishu_message_id: action === "patch" ? row.outbound_id ?? item.feishu_message_id : item.feishu_message_id,
    updated_at: Date.now(),
  } satisfies AssistantOutbound
  if (next.action === item.action && next.feishu_message_id === item.feishu_message_id) return item
  await store.save_assistant_outbound(next)
  return next
}

async function bind_wait_message(store: Store, item: WaitOutbound, msg_id: string) {
  const current = ((await store.get_assistant_outbound(item.id)) ?? item) as WaitOutbound
  if (current.feishu_message_id === msg_id && current.action === "reply") return current
  const next = {
    ...current,
    action: current.action === "deferred" ? "reply" : current.action,
    feishu_message_id: msg_id,
    updated_at: Date.now(),
  } satisfies AssistantOutbound
  await store.save_assistant_outbound(next)
  return next
}

async function waiting_requests(store: Store, session_id: string) {
  const row = await live_task(store, session_id)
  if (row) {
    const item = await head_wait(store, row)
    if (item) return [await sync_wait_head(store, row, item)]
  }
  return store.list_tasks({
    session_id,
    status: ["waiting_permission", "waiting_question"],
  })
}

// 同一 session 里，永远只允许队头 waiting request 对外可见。
async function next_waiting_request(store: Store, session_id: string) {
  return (await waiting_requests(store, session_id))[0] ?? null
}

async function visible_task(store: Store, session_id: string) {
  return (await next_waiting_request(store, session_id)) ?? (await live_task(store, session_id)) ?? store.get_last_task(session_id)
}

// 一个 originating task 可能连续触发多次 permission/question。
// 新 req 应继续挂到当前 waiting head（若有）或该 session 的活跃 task 上，不能再克隆 task。
async function claim_waiting_task(store: Store, session_id: string, req: string) {
  const hit = await store.get_task_by_req(req)
  if (hit) return hit
  const front = await next_waiting_request(store, session_id)
  if (front) return front
  return live_task(store, session_id)
}

function request_out(render: Render, row: Pick<Task, "status" | "req" | "note">) {
  if (!row.req) return
  if (row.status === "waiting_permission") {
    const meta = ameta(row.note)
    return render.approval({
      req: row.req,
      tool: meta?.tool || "tool",
      detail: meta?.detail || "",
    })
  }
  if (row.status === "waiting_question") {
    const meta = qmeta(row.note)
    return render.question({
      req: row.req,
      title: meta?.title || "请补充信息",
      opts: meta?.opts ?? [],
      custom: meta?.custom ?? true,
    })
  }
}

async function flush_next_request(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  session_id: string,
  chat_id: string,
) {
  const next = await next_waiting_request(store, session_id)
  if (!next) return
  if (!(await foreground(store, next))) return
  const item = await head_wait(store, next)
  if (!item) {
    const out = request_out(render, next)
    if (!out) return
    if (next.outbound_id) {
      await patch(store, task, feishu, next, chat_id, out)
      return
    }
    await deliver(store, task, feishu, next, chat_id, out)
    return
  }
  const visible = await promote_wait(store, next, item)
  const out = wait_out(render, visible)
  if (visible.action === "patch") {
    await patch(store, task, feishu, next, chat_id, out)
    return
  }
  await deliver(store, task, feishu, next, chat_id, out)
  const current = (await store.get_task(next.id)) ?? next
  if (current.outbound_id) {
    await bind_wait_message(store, visible, current.outbound_id)
  }
}

function site(
  conf: AppCfg,
  row?: Pick<Task, "directory" | "workspace_id"> | null,
  session?: Pick<ImSession, "directory" | "workspace_id"> | null,
) {
  return {
    directory: row?.directory ?? session?.directory ?? conf.opencode.directory,
    workspace: row?.workspace_id ?? session?.workspace_id ?? conf.opencode.workspace,
  }
}

async function fetch(store: Store, feishu: FeishuApi, inbound: InboundMessage) {
  if (inbound.assets.length === 0) return []
  return Promise.all(
    inbound.assets.map(async (item) => {
      const hit = await store.get_attachment({
        message_id: inbound.message_id,
        key: item.key,
      })
      if (hit) return hit.asset
      const asset = await feishu
        .fetch({
          message_id: inbound.message_id,
          asset: item,
        })
        .catch((err) => {
          throw new Error(`attachment fetch failed: ${item.name ?? item.key} - ${raw(err)}`)
        })
      const now = Date.now()
      await store.save_attachment({
        message_id: inbound.message_id,
        key: item.key,
        asset,
        created_at: now,
        updated_at: now,
      })
      return asset
    }),
  )
}

async function dest(store: Store, row: Task | null | undefined, session_id: string) {
  const hit = await store.get_session_by_opencode(session_id)
  if (hit) {
    return {
      chat_id: hit.chat_id,
      directory: row?.directory ?? hit.directory,
      workspace: row?.workspace_id ?? hit.workspace_id,
    }
  }
  if (!row) return
  const inbound = await store.get_inbound(row.inbound_id)
  if (inbound?.kind !== "message") return
  return {
    chat_id: inbound.chat_id,
    directory: row.directory,
    workspace: row.workspace_id,
  }
}

async function thread(store: Store, row: Pick<Task, "inbound_id"> | null | undefined) {
  if (!row) return
  const inbound = await store.get_inbound(row.inbound_id)
  if (inbound?.kind !== "message") return
  return inbound
}

async function foreground(store: Store, row: Task | null | undefined) {
  const inbound = await thread(store, row)
  if (!inbound || !row) return false
  const current = await store.get_session({
    tenant_id: inbound.tenant_id,
    chat_id: inbound.chat_id,
    thread_id: inbound.thread_id,
  })
  return current?.session_id === row.session_id
}

function visible(status?: Task["status"]) {
  return !!status && !done(status)
}

function display(status?: OpencodeStatus, local?: Task["status"]) {
  if (visible(local)) return local
  return state(status)
}

async function replay_waiting(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  row: Task | null | undefined,
  chat_id: string,
) {
  if (!row) return
  const item = await head_wait(store, row)
  if (!item && (row.status === "waiting_permission" || row.status === "waiting_question")) {
    const out = request_out(render, row)
    if (!out) return
    await patch(store, task, feishu, row, chat_id, out)
    return
  }
  const current = await sync_wait_head(store, row, item)
  if (current.req) {
    const front = await next_waiting_request(store, current.session_id)
    if (front && front.id !== current.id) return
  }
  if (!wait(current.status)) return

  if (current.status === "waiting_permission" || current.status === "waiting_question") {
    await flush_next_request(store, task, feishu, render, current.session_id, chat_id)
    return
  }

  const hold = await store.get_task_pending(current.id)
  if (!hold) {
    await store.drop_task_pending(current.id)
    await task.fail({
      id: current.id,
      err: "等待补充说明的附件上下文已丢失，请重新发送附件和说明。",
    })
    await publish(
      store,
      task,
      feishu,
      current.session_id,
      chat_id,
      render.err({
        text: "等待补充说明的附件上下文已丢失，请重新发送附件和说明。",
      }),
      undefined,
      current,
      error_meta,
    )
    return
  }
  if (ready(hold.assets).length !== hold.assets.length) {
    await store.drop_task_pending(current.id)
    await task.fail({
      id: current.id,
      err: "等待补充说明的附件缓存已失效，请重新发送附件和说明。",
    })
    await publish(
      store,
      task,
      feishu,
      current.session_id,
      chat_id,
      render.err({
        text: "等待补充说明的附件缓存已失效，请重新发送附件和说明。",
      }),
      undefined,
      current,
      error_meta,
    )
    return
  }
  await publish(
    store,
    task,
    feishu,
    current.session_id,
    chat_id,
    render.progress({
      text: holdmsg(hold.assets),
    }),
    { dedup: true },
    current,
    attachment_meta,
  )
}

async function saveout(store: Store, row: TaskRow, msg_id: string, out: RenderOut) {
  const hit = await store.get_outbound(row.id)
  const now = Date.now()
  await store.save_outbound({
    task_id: row.id,
    msg_id,
    kind: out.kind,
    payload: out.body,
    created_at: hit?.created_at ?? now,
    updated_at: now,
  })
}

async function emit_outbound(store: Store, row: TaskRow, out: RenderOut, meta: EmitMeta) {
  const [history, inbound] = await Promise.all([store.list_assistant_outbounds(row.id), store.get_inbound(row.inbound_id)])
  const now = Date.now()
  await store.save_assistant_outbound({
    id: "aso_" + crypto.randomUUID(),
    task_id: row.id,
    session_id: row.session_id,
    seq: (history.at(-1)?.seq ?? 0) + 1,
    kind: meta.kind,
    action: meta.action,
    state: "emitted",
    origin_inbound_id: row.inbound_id,
    origin_message_id: row.reply_anchor_message_id ?? inbound?.message_id ?? "",
    terminal: meta.terminal === true,
    feishu_message_id: meta.feishu_message_id,
    payload: out.body,
    created_at: now,
    updated_at: now,
  })
}

async function sync_visible_slot(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  row: TaskRow,
  msg_id: string,
  out: RenderOut,
  rotate = false,
) {
  if (rotate) {
    await task.link({
      id: row.id,
      outbound_id: msg_id,
    })
  }
  await saveout(store, row, msg_id, out)
}

async function deliver(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  row: Awaited<ReturnType<Store["get_last_task"]>>,
  chat_id: string,
  out: RenderOut,
  meta?: PublishMeta,
) {
  if (!row) {
    const result = await feishu.send({
      chat_id,
      out,
    })
    return result.id
  }
  const inbound = await store.get_inbound(row.inbound_id)
  const reply_id = row.reply_anchor_message_id ?? inbound?.message_id
  const result = reply_id
    ? await feishu.reply({
        msg_id: reply_id,
        out,
      })
    : await feishu.send({
        chat_id,
        out,
      })
  if (meta) {
    await emit_outbound(store, row, out, {
      ...meta,
      action: "reply",
      feishu_message_id: result.id,
    })
  }
  if (meta?.kind !== "intermediate") {
    await sync_visible_slot(store, task, row, result.id, out, true)
  }
  return result.id
}

async function patch(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  row: Awaited<ReturnType<Store["get_task_by_req"]>> | Awaited<ReturnType<Store["get_last_task"]>>,
  chat_id: string,
  out: RenderOut,
) {
  if (!row) return
  await publish(store, task, feishu, row.session_id, chat_id, out, undefined, row)
}

async function allow(store: Store, msg: InboundMessage, feishu: FeishuApi, bot_id?: string) {
  if (!group(msg.chat_type)) return true
  const row = await store.get_session({
    tenant_id: msg.tenant_id,
    chat_id: msg.chat_id,
    thread_id: msg.thread_id,
  })
  if (row) return true
  if (msg.mentions.length === 0) return false
  if (bot_id) return msg.mentions.includes(bot_id)
  await feishu.sync()
  const names = feishu.names()
  if (names.length === 0) return false
  return !!msg.mention_names?.some((item) => names.includes(item))
}

function text(out: RenderOut) {
  if (!out.body || typeof out.body !== "object") return
  if (!("text" in out.body)) return
  const val = out.body.text
  if (typeof val !== "string") return
  return val
}

function terminal_status_patch(out: RenderOut): RenderOut {
  if (out.kind !== "card") return out
  if (!out.body || typeof out.body !== "object") return out
  return {
    kind: "card",
    body: {
      ...out.body,
      title: "最终已完成",
      state: "final",
      text: "请查看下方最终答复",
    },
  }
}

async function result(
  opencode: ReturnType<typeof createOpencodeSvc>,
  input: { session_id: string; directory?: string; workspace?: string },
) {
  if (opencode.result) return opencode.result(input)
  const text = await opencode.last(input)
  if (text) return { state: "ok", text } satisfies OpencodeResult
  return { state: "empty" } satisfies OpencodeResult
}

function result_key(val: OpencodeResult) {
  if (val.hash) return val.hash
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        state: val.state,
        text: val.text ?? "",
        entries: val.entries ?? [],
      }),
    )
    .digest("hex")
}

type ReconcileOutcome = "resumable" | "settled"

function remote_busy(status?: OpencodeStatus) {
  return status?.type === "busy" || status?.type === "retry"
}

function descendants(list: Awaited<ReturnType<OpencodeSvc["sessions"]>>, root: string) {
  const children = new Map<string, string[]>()
  for (const item of list) {
    if (!item.parent_id) continue
    const current = children.get(item.parent_id) ?? []
    current.push(item.id)
    children.set(item.parent_id, current)
  }
  const seen = new Set<string>()
  const stack = [...(children.get(root) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()
    if (!id || seen.has(id)) continue
    seen.add(id)
    stack.push(...(children.get(id) ?? []))
  }
  return [...seen]
}

async function classify_idle(
  opencode: ReturnType<typeof createOpencodeSvc>,
  row: Task,
  to: { directory?: string; workspace?: string },
  val: OpencodeResult,
) {
  const [status, list] = await Promise.all([
    opencode.status({
      directory: to.directory,
      workspace: to.workspace,
    }).catch(() => null),
    opencode.sessions({
      directory: to.directory,
      limit: 200,
    }).catch(() => null),
  ])
  if (!status || !list) return "resumable" as const
  const busy = descendants(list, row.session_id).some((id) => remote_busy(status[id]))
  if (busy) return "resumable" as const
  if (val.completed !== true) return "resumable" as const
  if (val.state === "empty") return "empty" as const
  return "final" as const
}

async function reconcile_non_wait(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  row: Task,
  to: { chat_id: string; directory?: string; workspace?: string },
  input: { empty_text: string },
): Promise<ReconcileOutcome> {
  const current = (await store.get_task(row.id)) ?? row
  if (done(current.status) || wait(current.status)) return "settled"

  const val = await result(opencode, {
    session_id: current.session_id,
    directory: to.directory,
    workspace: to.workspace,
  })
  const hash = result_key(val)
  const state = await classify_idle(opencode, current, to, val)

  if (state === "resumable") {
    if (current.result_hash === hash) return "resumable"
    await task.checkpoint({
      id: current.id,
      result_hash: hash,
      note: val.text,
    })
    if (val.text) {
      const latest = (await store.get_task(current.id)) ?? current
      await publish(
        store,
        task,
        feishu,
        current.session_id,
        to.chat_id,
        render.intermediate({
          text: val.text,
        }),
        undefined,
        latest,
        intermediate_meta,
      )
    }
    return "resumable"
  }

  if (state === "final") {
    const note = val.text ?? done_msg(val)
    await publish(
      store,
      task,
      feishu,
      current.session_id,
      to.chat_id,
      render.final({
        text: note,
      }),
      undefined,
      current,
      final_meta,
    )
    const latest = (await store.get_task(current.id)) ?? current
    await task.close({
      id: current.id,
      status: "completed",
      terminal_kind: "final",
      terminal_outbound_id: latest.outbound_id ?? current.outbound_id,
      result_hash: hash,
      note,
    })
    return "settled"
  }

  await publish(
    store,
    task,
    feishu,
    current.session_id,
    to.chat_id,
    render.err({
      text: input.empty_text,
    }),
    undefined,
    current,
    error_meta,
  )
  const latest = (await store.get_task(current.id)) ?? current
  await task.close({
    id: current.id,
    status: "failed",
    terminal_kind: "error",
    terminal_outbound_id: latest.outbound_id ?? current.outbound_id,
    result_hash: hash,
    err: input.empty_text,
    note: input.empty_text,
  })
  return "settled"
}

async function sync_msg(store: Store, mode: RecoverMode) {
  if (mode !== "boot") return recover_msg(mode, "sync")
  const item = await store.get_conn("opencode")
  if (!item) return "OpenCode 正在建立连接，稍后会继续同步执行状态…"
  if (item.status === "connecting") return "OpenCode 正在建立连接，稍后会继续同步执行状态…"
  if (item.status === "reconnecting" || item.status === "error") return signal_msg(item)
  return recover_msg(mode, "sync")
}

async function stale_msg(store: Store) {
  const item = await store.get_conn("opencode")
  if (!item || item.status === "connecting") return "OpenCode 正在建立连接，稍后会继续同步执行状态…"
  if (item.status === "reconnecting" || item.status === "error") return signal_msg(item)
  return "长时间无新事件，正在继续同步执行状态…"
}

function file(val?: string) {
  if (!val) return ""
  const list = val.split(/[\\/]/).filter(Boolean)
  return list.at(-1) ?? val
}

function str(val: Record<string, unknown>, key: string) {
  const item = val[key]
  if (typeof item !== "string") return
  return item
}

function state(val?: OpencodeStatus) {
  if (!val) return "idle"
  if (val.type === "retry") return `retry#${val.attempt}`
  return val.type
}

function scope(
  current: Awaited<ReturnType<Store["get_session"]>>,
  pref: Awaited<ReturnType<typeof prefs>>,
  conf: AppCfg,
) {
  return {
    directory: current?.directory ?? pref.chat?.directory ?? pref.user?.directory ?? conf.opencode.directory,
    workspace: current?.workspace_id ?? pref.chat?.workspace_id ?? pref.user?.workspace_id ?? conf.opencode.workspace,
  }
}

function sessions(
  list: Awaited<ReturnType<ReturnType<typeof createOpencodeSvc>["sessions"]>>,
  status: Record<string, OpencodeStatus>,
  local: Record<string, Task["status"] | undefined>,
  dir?: string,
  current?: string,
) {
  if (list.length === 0) return `当前目录 ${repo(dir)} 下暂无会话。`
  return [
    `最近会话（共 ${list.length} 条）：`,
    ...list.map((item, i) =>
      [
        `${i + 1}. ${item.id === current ? "[当前] " : ""}[${display(status[item.id], local[item.id])}] ${item.title}`,
        `session: ${item.id}`,
        `目录: ${repo(item.directory, item.workspace_id)}`,
        `更新: ${time(item.updated_at)}`,
      ].join("\n"),
    ),
    "",
    "使用 /session <session_id> 切换当前会话。",
  ].join("\n\n")
}

function skills(list: OpencodeSkill[]) {
  if (list.length === 0) return "当前没有可用技能。"
  return [
    `技能列表（共 ${list.length} 项）：`,
    ...list.map((item, i) => `${i + 1}. ${item.name}${item.description ? ` - ${item.description}` : ""}`),
  ].join("\n")
}

function agents(list: OpencodeAgent[]) {
  if (list.length === 0) return "当前没有可用 agent。"
  return [
    `Agent 列表（共 ${list.length} 项）：`,
    ...list.map((item, i) =>
      `${i + 1}. ${item.name} [${item.mode}]${item.model ? ` ${item.model.provider_id}/${item.model.model_id}` : ""}${item.description ? ` - ${item.description}` : ""}`,
    ),
  ].join("\n")
}

function models(list: OpencodeProvider[]) {
  if (list.length === 0) return "当前没有已连接 provider。"

  const label = (item: OpencodeProvider["models"][number]) => {
    if (item.name === item.id) return item.id
    return `${item.name} (${item.id})`
  }

  const names = (items: OpencodeProvider["models"]) => {
    if (items.length === 0) return "-"
    if (items.length <= 8) return items.map(label).join("、")
    return items
      .slice(0, 8)
      .map(label)
      .concat(`等 ${items.length} 个`)
      .join("、")
  }

  return [
    `当前已连接 provider / model（共 ${list.length} 项）：`,
    ...list.map((item, i) =>
      [
        `${i + 1}. ${item.name}${item.connected ? " [connected]" : ""}`,
        `provider: ${item.id}`,
        `default: ${item.default_model ?? "-"}`,
        `models: ${names(item.models)}`,
      ].join("\n"),
    ),
    "",
    "使用 /model <provider>/<model_id> 切换当前模型，或 /model reset 恢复默认。",
  ].join("\n\n")
}

function mcps(list: OpencodeMcp[]) {
  if (list.length === 0) return "当前没有 MCP 配置。"
  return [
    `MCP 状态（共 ${list.length} 项）：`,
    ...list.map((item, i) =>
      `${i + 1}. ${item.name} [${item.status}]${item.error ? ` ${short(item.error)}` : ""}`,
    ),
  ].join("\n")
}

function commands(list: OpencodeCommand[]) {
  return [
    "IM 原生命令：",
    ...local().map((item) => `- ${item.name} ${item.description}`),
    "",
    list.length === 0 ? "OpenCode 可转发命令：\n- 暂无" : "OpenCode 可转发命令：",
    ...list.map((item) =>
      `- /${item.name}${item.source ? ` [${item.source}]` : ""}${item.description ? ` ${item.description}` : ""}`,
    ),
  ].join("\n")
}

function similar(list: OpencodeCommand[], input: string) {
  return list
    .filter((item) => item.name.startsWith(input) || item.name.includes(input) || input.includes(item.name))
    .slice(0, 5)
}

function step(part: Record<string, unknown>) {
  if (part.type === "tool") {
    const tool = typeof part.tool === "string" ? part.tool : "tool"
    const state = part.state
    if (!state || typeof state !== "object" || !("status" in state)) return `正在执行 ${tool}`
    const input =
      "input" in state && state.input && typeof state.input === "object"
        ? (state.input as Record<string, unknown>)
        : {}
    const title = "title" in state && typeof state.title === "string" ? state.title : undefined
    const name =
      tool === "read"
        ? `读取 ${file(str(input, "filePath")) || "文件"}`
        : tool === "edit"
          ? `修改 ${file(str(input, "filePath")) || "文件"}`
          : tool === "write"
            ? `写入 ${file(str(input, "filePath")) || "文件"}`
            : tool === "bash"
              ? `执行 ${short(str(input, "command")) || "命令"}`
              : tool === "grep"
                ? `搜索 ${short(str(input, "pattern")) || "内容"}`
                : tool === "glob"
                  ? `匹配 ${short(str(input, "pattern")) || "路径"}`
                  : tool === "ls"
                    ? `查看 ${file(str(input, "path")) || "目录"}`
                    : tool === "webfetch"
                      ? `抓取 ${short(str(input, "url")) || "网页"}`
                      : tool === "websearch"
                        ? `搜索 ${short(str(input, "query")) || "网页"}`
                        : tool === "codesearch"
                          ? `检索 ${short(str(input, "query")) || "代码"}`
                          : tool === "task"
                            ? `委托 ${short(title ?? str(input, "description") ?? str(input, "subagent_type")) || "子任务"}`
                            : tool === "skill"
                              ? `调用技能 ${short(str(input, "name")) || ""}`.trim()
                              : short(title ?? tool)
    if (state.status === "running") return `正在${name}`
    if (state.status === "completed") return `已完成：${name}`
    if (state.status === "error") return `执行失败：${name}`
    return `等待：${name}`
  }
  if (part.type === "step-start") return "开始新步骤"
  if (part.type === "step-finish") return "步骤已完成"
  if (part.type === "retry") return "模型重试中"
}

export async function publish(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  session_id: string,
  chat_id: string,
  out: RenderOut,
  opts?: { dedup?: boolean },
  base?: Awaited<ReturnType<Store["get_last_task"]>>,
  meta?: PublishMeta,
) {
  let row = base ?? (await store.get_last_task(session_id))
  const note = text(out)
  if (opts?.dedup && row) {
    const hit = await store.get_outbound(row.id)
    if (hit && hit.kind === out.kind && JSON.stringify(hit.payload) === JSON.stringify(out.body)) return row
    if (!hit && row.note && note && row.note === note) return row
  }

  if (!row) {
    await feishu.send({
      chat_id,
      out,
    })
    return row
  }

  const current_row: TaskRow = row
  let history: AssistantOutbound[] | undefined
  const assistant_history = async () => {
    history ??= await store.list_assistant_outbounds(current_row.id)
    return history
  }

  const first_intermediate =
    meta?.kind === "intermediate" &&
    !row.status_outbound_id &&
    !(await assistant_history()).some((item) => item.kind === "intermediate" && item.state === "emitted")
  const intermediate_status_target = row.outbound_id

  const final_after_intermediate =
    !!row.outbound_id &&
    meta?.kind === "final" &&
    (await assistant_history()).some((item) => item.kind === "intermediate" && item.state === "emitted")

  if (final_after_intermediate) {
    await deliver(store, task, feishu, row, chat_id, out, meta)
    if (typeof row.status_outbound_id === "string") {
      await feishu
        .patch({
          msg_id: row.status_outbound_id,
          out: terminal_status_patch(out),
        })
        .catch((err) => {
          console.warn("[publish.patch.initial]", err instanceof Error ? err.message : String(err))
        })
    }
    if (note) {
      await task.note({
        id: row.id,
        note,
      })
    }
    return row
  }

  if (row.outbound_id && meta?.kind !== "intermediate" && !final_after_intermediate) {
    const patch_row = row
    const patch_target = row.outbound_id
    try {
      await feishu.patch({
        msg_id: patch_target,
        out,
      })
    } catch (err) {
      console.warn("[publish.patch]", err instanceof Error ? err.message : String(err))
      const reply_id = await deliver(store, task, feishu, patch_row, chat_id, out, meta)
      if (reply_id && patch_row.status_outbound_id === patch_target) {
        await task.link({
          id: patch_row.id,
          outbound_id: reply_id,
          status_outbound_id: reply_id,
        })
      }
      if (note) {
        await task.note({
          id: row.id,
          note,
        })
      }
      return row
    }
    if (meta) {
      await emit_outbound(store, patch_row, out, {
        ...meta,
        action: "patch",
        feishu_message_id: patch_target,
      })
    }
    await sync_visible_slot(store, task, patch_row, patch_target, out)
    if (note) {
      await task.note({
        id: row.id,
        note,
      })
    }
    return row
  }

  const reply_id = await deliver(store, task, feishu, row, chat_id, out, meta)
  if (first_intermediate && reply_id) {
    const status_target = intermediate_status_target ?? reply_id
    await task.link({
      id: row.id,
      outbound_id: status_target,
      status_outbound_id: status_target,
    })
    row = (await store.get_task(row.id)) ?? row
  }
  if (note) {
    await task.note({
      id: row.id,
      note,
    })
  }
  return row
}

function createTick(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
) {
  const wait = new Map<string, ReturnType<typeof setTimeout>>()
  const list = new Map<string, Tick>()
  const delay = 1200

  const flush = async (session_id: string) => {
    const timer = wait.get(session_id)
    if (timer) clearTimeout(timer)
    wait.delete(session_id)
    const item = list.get(session_id)
    if (!item) return
    list.delete(session_id)
    await publish(store, task, feishu, session_id, item.chat_id, item.out, {
      dedup: true,
    }, undefined, item.meta)
  }

  const push = async (session_id: string, chat_id: string, out: RenderOut, meta?: PublishMeta) => {
    list.set(session_id, { chat_id, out, meta })
    if (wait.has(session_id)) return
    wait.set(
      session_id,
      setTimeout(() => {
        flush(session_id).catch((err) => {
          console.error("[tick]", err)
        })
      }, delay),
    )
  }

  const stop = async () => {
    const keys = [...new Set([...wait.keys(), ...list.keys()])]
    for (const id of keys) {
      await flush(id)
    }
  }

  return { push, flush, stop }
}

async function poll(
  conf: AppCfg,
  opencode: ReturnType<typeof createOpencodeSvc>,
  sessions: Map<string, ImSession>,
  list: Task[],
) {
  const states = new Map<string, Record<string, OpencodeStatus> | null>()
  const keys = [...new Set(list.map((row) => {
    const val = site(conf, row, sessions.get(row.session_id))
    return [val.directory ?? "", val.workspace ?? ""].join("|")
  }))]

  await Promise.all(
    keys.map(async (key) => {
      const [directory, workspace] = key.split("|")
      const data = await opencode.status({
        directory: directory || undefined,
        workspace: workspace || undefined,
      }).catch(() => null)
      states.set(key, data)
    }),
  )

  return states
}

export async function sweep(
  conf: AppCfg,
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  now = Date.now(),
  gap = 45000,
) {
  const list = [...latest(await store.list_tasks({
    status: ["queued", "acked", "running", "waiting_permission", "waiting_question", "waiting_attachment"],
  })).values()].filter(
    (row) => now - row.updated_at >= gap,
  )
  if (list.length === 0) return
  const sessions = new Map<string, ImSession>()
  await Promise.all(
    list.map(async (row) => {
      const session = await store.get_session_by_opencode(row.session_id)
      if (session) sessions.set(row.session_id, session)
    }),
  )
  const states = await poll(conf, opencode, sessions, list)

  for (const row of list) {
    const to = await dest(store, row, row.session_id)
    if (!to) continue
    const shown = await foreground(store, row)
    const val = site(conf, row, sessions.get(row.session_id))
    const key = [val.directory ?? "", val.workspace ?? ""].join("|")
    const data = states.get(key)
    const state = data?.[row.session_id]
    const miss = data === null || data === undefined
    const busy = state?.type === "busy" || state?.type === "retry"

    if (row.status === "waiting_permission" && row.req) {
      if (miss) continue
      if (!busy) {
        await task.fail({
          id: row.id,
          err: "长时间未收到后续事件，之前的权限审批已失效，请重新发送上一条消息。",
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: "长时间未收到后续事件，之前的权限审批已失效，请重新发送上一条消息。",
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      const front = await next_waiting_request(store, row.session_id)
      if (front?.id !== row.id) continue
      const meta = ameta(row.note)
      await patch(
        store,
        task,
        feishu,
        row,
        to.chat_id,
        render.approval({
          req: row.req,
          tool: meta?.tool || "tool",
          detail: meta?.detail || "",
        }),
      )
      continue
    }

    if (row.status === "waiting_question" && row.req) {
      if (miss) continue
      if (!busy) {
        await task.fail({
          id: row.id,
          err: "长时间未收到后续事件，之前的补充问题已失效，请重新发送上一条消息。",
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: "长时间未收到后续事件，之前的补充问题已失效，请重新发送上一条消息。",
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      const front = await next_waiting_request(store, row.session_id)
      if (front?.id !== row.id) continue
      const meta = qmeta(row.note)
      await patch(
        store,
        task,
        feishu,
        row,
        to.chat_id,
        render.question({
          req: row.req,
          title: meta?.title || "请补充信息",
          opts: meta?.opts ?? [],
          custom: meta?.custom ?? true,
        }),
      )
      continue
    }

    if (row.status === "waiting_attachment") {
      const hold = await store.get_task_pending(row.id)
      if (!hold) {
        await store.drop_task_pending(row.id)
        await task.fail({
          id: row.id,
          err: "等待补充说明的附件上下文已丢失，请重新发送附件和说明。",
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: "等待补充说明的附件上下文已丢失，请重新发送附件和说明。",
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (ready(hold.assets).length !== hold.assets.length) {
        await store.drop_task_pending(row.id)
        await task.fail({
          id: row.id,
          err: "等待补充说明的附件缓存已失效，请重新发送附件和说明。",
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: "等待补充说明的附件缓存已失效，请重新发送附件和说明。",
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: "长时间未继续输入，仍在等待你的补充说明。请再发一句你希望我做什么。",
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if (miss) {
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: await stale_msg(store),
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if ((row.status === "queued" || row.status === "acked") && busy) {
      await task.run(row.id)
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: "长时间无新事件，正在继续同步执行状态…",
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if (row.status === "running" && busy) {
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress(
          state?.type === "retry"
            ? {
                step: `重试第 ${state.attempt} 次`,
                text: state.message || "模型正在重试",
              }
            : {
                text: stuck(row.status),
              },
        ),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if (row.status === "running" && !busy) {
      await finish(
        store,
        task,
        feishu,
        render,
        opencode,
        row,
        to,
        "长时间未收到后续事件，本次执行已结束但未生成可恢复结果，请重新发送上一条消息。",
      )
      continue
    }

    await publish(
      store,
      task,
      feishu,
      row.session_id,
      to.chat_id,
      render.progress({
        text: stuck(row.status),
      }),
      { dedup: true },
      row,
      progress_meta,
    )
  }
}

function createWatch(
  conf: AppCfg,
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
) {
  const every = 15000
  let timer: ReturnType<typeof setInterval> | undefined

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        sweep(conf, store, task, feishu, render, opencode).catch((err) => {
          console.error("[watch]", err)
        })
      }, every)
    },

    async stop() {
      if (!timer) return
      clearInterval(timer)
      timer = undefined
    },
  }
}

function errtext(val: unknown) {
  if (!val || typeof val !== "object") return String(val)
  const name = "name" in val ? String(val.name) : "UnknownError"
  const data = "data" in val ? val.data : undefined
  if (data && typeof data === "object" && "message" in data) {
    return String(data.message)
  }
  return name
}

function ekey(event: OpencodeEvent, row?: Task | null) {
  if (event.type === "permission.asked") {
    const req = String(event.properties.id ?? "")
    if (!req) return
    return `opencode:permission.asked:${req}:${String(event.properties.permission ?? "")}:${JSON.stringify(event.properties.metadata ?? {})}`
  }
  if (event.type === "question.asked") {
    const req = String(event.properties.id ?? "")
    if (!req) return
    const list = Array.isArray(event.properties.questions) ? event.properties.questions : []
    return `opencode:question.asked:${req}:${JSON.stringify(list)}`
  }
  if (event.type === "session.status") {
    if (!row?.id) return
    const status = event.properties.status as { type?: string; attempt?: number; message?: string } | undefined
    if (status?.type === "idle") return `opencode:session.status:idle:${row.id}`
    if (status?.type === "busy") return `opencode:session.status:busy:${row.id}`
    if (status?.type === "retry") return `opencode:session.status:retry:${row.id}:${status.attempt ?? 0}:${status.message ?? ""}`
    return
  }
  if (event.type === "session.error") {
    if (!row?.id) return
    return `opencode:session.error:${row.id}:${errtext(event.properties.error)}`
  }
  if (event.type === "message.updated") {
    const info = event.properties.info as { id?: string } | undefined
    if (!info?.id) return
    return `opencode:message.updated:${info.id}`
  }
  if (event.type === "message.part.updated") {
    const part = event.properties.part as { messageID?: string; id?: string } | undefined
    const time = typeof event.properties.time === "number" ? event.properties.time : Number(event.properties.time ?? 0)
    if (!part?.messageID || !part.id || !time) return
    return `opencode:message.part.updated:${part.messageID}:${part.id}:${time}`
  }
}

async function once(
  store: Store,
  event: OpencodeEvent,
  row: Task | null | undefined,
  run: () => Promise<void>,
) {
  const key = ekey(event, row)
  if (key && (await store.seen(key))) return false
  await run()
  if (key) await store.mark(key)
  return true
}

function latest(list: Task[]) {
  return [...list].sort((a, b) => a.created_at - b.created_at).reduce((map, item) => {
    map.set(item.session_id, item)
    return map
  }, new Map<string, Task>())
}

export async function signal(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  text: string,
  status: Task["status"][] = ["queued", "acked", "running"],
  cool = 10000,
) {
  const now = Date.now()
  const list = [...latest(await store.list_tasks({ status })).values()]
  await Promise.all(
    list.map(async (row) => {
      if (row.status === "aborted" || row.status === "completed" || row.status === "failed") return
      if (cool > 0 && now - row.updated_at < cool) return
      const to = await dest(store, row, row.session_id)
      if (!to) return
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text,
        }),
        { dedup: true },
        row,
        progress_meta,
      )
    }),
  )
}

async function finish(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  row: Task,
  to: { chat_id: string; directory?: string; workspace?: string },
  empty_text: string,
) {
  return reconcile_non_wait(store, task, feishu, render, opencode, row, to, {
    empty_text,
  })
}

async function rebind_task(
  store: Store,
  task: TaskSvc,
  prev: Task,
  item: ImSession,
  inbound: InboundMessage,
) {
  await task.rebind({
    id: prev.id,
    im_session_id: item.id,
    inbound_id: inbound.id,
    reply_anchor_message_id: inbound.message_id,
    directory: item.directory,
    workspace_id: item.workspace_id,
    clear_result_hash: true,
  })
  return (await store.get_task(prev.id)) ?? prev
}

export async function probe(
  conf: AppCfg,
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  row: Task,
  ping = false,
) {
  const current = await store.get_task(row.id)
  if (!current || !active(current.status)) return "settled" as const
  const session = await store.get_session_by_opencode(current.session_id)
  const val = site(conf, current, session)
  const data = await opencode
    .status({
      directory: val.directory,
      workspace: val.workspace,
    })
    .catch(() => null)
  if (!data) return "unknown" as const
  const status = data[current.session_id]
  const busy = status?.type === "busy" || status?.type === "retry"
  const to = await dest(store, current, current.session_id)
  if (!to) return busy ? ("busy" as const) : ("unknown" as const)

  if (busy) {
    if (current.status === "queued" || current.status === "acked") {
      await task.run(current.id)
    }
    if (ping) {
      const next = (await store.get_task(current.id)) ?? current
      await publish(
        store,
        task,
        feishu,
        current.session_id,
        to.chat_id,
        status?.type === "retry"
          ? render.progress({
              step: `重试第 ${status.attempt ?? 0} 次`,
              text: status.message ?? "已重新确认：模型正在重试。",
            })
          : render.progress({
              text:
                current.status === "queued" || current.status === "acked"
                  ? "已重新确认：请求已提交，仍在处理中…"
                  : "已重新确认：上一条消息仍在处理中，请稍候…",
            }),
        { dedup: true },
        next,
        progress_meta,
      )
    }
    return "busy" as const
  }

  if (wait(current.status)) return "settled" as const

  const outcome = await finish(
    store,
    task,
    feishu,
    render,
    opencode,
    current,
    to,
    "已重新检查上一条执行状态：当前会话已结束，但没有可恢复结果，请重新发送上一条消息。",
  )
  if (outcome === "settled") {
    return "settled" as const
  }
  return "resumable" as const
}

export async function recover(
  conf: AppCfg,
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  mode: RecoverMode = "boot",
) {
  const list = [...latest(await store.list_tasks({
    status: ["queued", "acked", "running", "waiting_permission", "waiting_question", "waiting_attachment"],
  })).values()]
  if (list.length === 0) return

  const sessions = new Map<string, ImSession>()
  await Promise.all(
    list.map(async (row) => {
      const session = await store.get_session_by_opencode(row.session_id)
      if (session) sessions.set(row.session_id, session)
    }),
  )
  const states = await poll(conf, opencode, sessions, list)

  for (const row of list) {
    const to = await dest(store, row, row.session_id)
    if (!to) continue
    const shown = await foreground(store, row)
    const val = site(conf, row, sessions.get(row.session_id))
    const scope = [val.directory ?? "", val.workspace ?? ""].join("|")
    const data = states.get(scope)
    const status = data?.[row.session_id]
    const miss = data === null || data === undefined
    const busy = status?.type === "busy" || status?.type === "retry"

    if (row.status === "waiting_permission" && row.req) {
      if (miss) continue
      if (!busy) {
        await task.fail({
          id: row.id,
          err: recover_msg(mode, "approval"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg(mode, "approval"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      const front = await next_waiting_request(store, row.session_id)
      if (front?.id !== row.id) continue
      const meta = ameta(row.note)
      await patch(
        store,
        task,
        feishu,
        row,
        to.chat_id,
        render.approval({
          req: row.req,
          tool: meta?.tool || "tool",
          detail: meta?.detail || "",
        }),
      )
      continue
    }

    if (row.status === "waiting_question" && row.req) {
      if (miss) continue
      if (!busy) {
        await task.fail({
          id: row.id,
          err: recover_msg(mode, "question"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg(mode, "question"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      const front = await next_waiting_request(store, row.session_id)
      if (front?.id !== row.id) continue
      const meta = qmeta(row.note)
      await patch(
        store,
        task,
        feishu,
        row,
        to.chat_id,
        render.question({
          req: row.req,
          title: meta?.title || "请补充信息",
          opts: meta?.opts ?? [],
          custom: meta?.custom ?? true,
        }),
      )
      continue
    }

    if (row.status === "waiting_attachment") {
      const hold = await store.get_task_pending(row.id)
      if (!hold) {
        await store.drop_task_pending(row.id)
        await task.fail({
          id: row.id,
          err: recover_msg(mode, "attachment"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg(mode, "attachment"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (ready(hold.assets).length !== hold.assets.length) {
        await store.drop_task_pending(row.id)
        await task.fail({
          id: row.id,
          err: recover_msg(mode, "cache"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg(mode, "cache"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: recover_msg(mode, "wait"),
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if (miss) {
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: await sync_msg(store, mode),
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if (row.status === "queued" || row.status === "acked") {
      if (busy) {
        await task.run(row.id)
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.progress({
            text: await sync_msg(store, mode),
          }),
          { dedup: true },
          row,
          progress_meta,
        )
        continue
      }
      await finish(
        store,
        task,
        feishu,
        render,
        opencode,
        row,
        to,
        recover_msg(mode, "queued"),
      )
      continue
    }

    if (row.status !== "running") continue
    if (busy) {
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: await sync_msg(store, mode),
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }
    await finish(
      store,
      task,
      feishu,
      render,
      opencode,
      row,
      to,
      recover_msg(mode, "running"),
    )
    continue
  }
}

export async function resume(
  conf: AppCfg,
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
) {
  const list = [...latest(await store.list_tasks({
    status: ["queued", "acked", "running", "waiting_permission", "waiting_question", "waiting_attachment"],
  })).values()]
  if (list.length === 0) return
  const sessions = new Map<string, ImSession>()
  await Promise.all(
    list.map(async (row) => {
      const session = await store.get_session_by_opencode(row.session_id)
      if (session) sessions.set(row.session_id, session)
    }),
  )
  const states = await poll(conf, opencode, sessions, list)

  for (const row of list) {
    const to = await dest(store, row, row.session_id)
    if (!to) continue
    const shown = await foreground(store, row)
    const val = site(conf, row, sessions.get(row.session_id))
    const key = [val.directory ?? "", val.workspace ?? ""].join("|")
    const data = states.get(key)
    const status = data?.[row.session_id]
    const miss = data === null || data === undefined
    const busy = status?.type === "busy" || status?.type === "retry"

    if (row.status === "waiting_permission" && row.req) {
      if (miss) {
        if (!shown) continue
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.progress({
            text: recover_msg("message", "sync"),
          }),
          { dedup: true },
          row,
          progress_meta,
        )
        continue
      }
      if (!busy) {
        await task.fail({
          id: row.id,
          err: recover_msg("message", "approval"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg("message", "approval"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      const front = await next_waiting_request(store, row.session_id)
      if (front?.id !== row.id) continue
      const meta = ameta(row.note)
      await patch(
        store,
        task,
        feishu,
        row,
        to.chat_id,
        render.approval({
          req: row.req,
          tool: meta?.tool || "tool",
          detail: meta?.detail || "",
        }),
      )
      continue
    }

    if (row.status === "waiting_question" && row.req) {
      if (miss) {
        if (!shown) continue
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.progress({
            text: recover_msg("message", "sync"),
          }),
          { dedup: true },
          row,
          progress_meta,
        )
        continue
      }
      if (!busy) {
        await task.fail({
          id: row.id,
          err: recover_msg("message", "question"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg("message", "question"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      const front = await next_waiting_request(store, row.session_id)
      if (front?.id !== row.id) continue
      const meta = qmeta(row.note)
      await patch(
        store,
        task,
        feishu,
        row,
        to.chat_id,
        render.question({
          req: row.req,
          title: meta?.title || "请补充信息",
          opts: meta?.opts ?? [],
          custom: meta?.custom ?? true,
        }),
      )
      continue
    }

    if (row.status === "waiting_attachment") {
      const hold = await store.get_task_pending(row.id)
      if (!hold) {
        await store.drop_task_pending(row.id)
        await task.fail({
          id: row.id,
          err: recover_msg("message", "attachment"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg("message", "attachment"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (ready(hold.assets).length !== hold.assets.length) {
        await store.drop_task_pending(row.id)
        await task.fail({
          id: row.id,
          err: recover_msg("message", "cache"),
        })
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: recover_msg("message", "cache"),
          }),
          undefined,
          row,
          error_meta,
        )
        continue
      }
      if (!shown) continue
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: recover_msg("message", "wait"),
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if (miss) {
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: recover_msg("message", "sync"),
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }

    if (row.status === "queued" || row.status === "acked") {
      if (busy) {
        await task.run(row.id)
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.progress({
            text: recover_msg("message", "sync"),
          }),
          { dedup: true },
          row,
          progress_meta,
        )
        continue
      }
      await finish(
        store,
        task,
        feishu,
        render,
        opencode,
        row,
        to,
        recover_msg("message", "queued"),
      )
      continue
    }

    if (row.status !== "running") continue
    if (busy) {
      await publish(
        store,
        task,
        feishu,
        row.session_id,
        to.chat_id,
        render.progress({
          text: recover_msg("message", "sync"),
        }),
        { dedup: true },
        row,
        progress_meta,
      )
      continue
    }
    await finish(
      store,
      task,
      feishu,
      render,
      opencode,
      row,
      to,
      recover_msg("message", "running"),
    )
    continue
  }
}

export async function on_conn(
  conf: AppCfg,
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  prev: ConnState | null,
  item: ConnState,
) {
  const next = item.status === "reconnecting" && prev?.status === "reconnecting"
    ? {
        ...item,
        err: item.err ?? prev.err,
        attempt: item.attempt ?? prev.attempt,
        wait_ms: item.wait_ms ?? prev.wait_ms,
      }
    : item
  await store.set_conn(next)
  if (next.name !== "message" && next.name !== "opencode") return
  const text = signal_msg(next)
  if (next.status === "error" && (prev?.status === "connecting" || prev?.status === "ready" || prev?.status === "reconnecting")) {
    return
  }
  if (next.status === "reconnecting") {
    if (prev?.status === "reconnecting" && signal_msg(prev) === text) return
    await signal(
      store,
      task,
      feishu,
      render,
      text,
      ["queued", "acked", "running"],
      prev?.status === "reconnecting" || prev?.status === "ready" || prev?.status === "error" ? 0 : 10000,
    )
    return
  }
  if (next.status === "error") {
    await signal(store, task, feishu, render, text)
    return
  }
  if (next.status !== "ready") return
  if (next.name === "opencode" && prev?.status === "connecting") {
    await recover(conf, store, task, feishu, render, opencode, "opencode")
    return
  }
  if (prev?.status !== "reconnecting" && prev?.status !== "error") return
  if (next.name === "message") {
    await resume(conf, store, task, feishu, render, opencode)
    return
  }
  await recover(conf, store, task, feishu, render, opencode, "opencode")
}

export async function on_cmd(
  text: string,
  conf: AppCfg,
  route: ReturnType<typeof createSessionSvc>,
  task: ReturnType<typeof createTaskSvc>,
  store: Store,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  inbound: Extract<Awaited<ReturnType<Store["get_inbound"]>>, { kind: "message" }>,
) {
  const cmd = parseCmd(text)
  if (!cmd) return false

  if (cmd.name === "help") {
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: { text: help() },
      },
    })
    return true
  }

  const current = await store.get_session({
    tenant_id: inbound.tenant_id,
    chat_id: inbound.chat_id,
    thread_id: inbound.thread_id,
  })
  let last = current ? await store.get_last_task(current.session_id) : null
  const pref = await prefs(store, inbound)
  const base = scope(current, pref, conf)
  const syncd =
    current && last && active(last.status) && cmd.name !== "abort" && cmd.name !== "session" && cmd.name !== "new"
      ? await probe(conf, store, task, feishu, render, opencode, last, cmd.name !== "status")
      : undefined
  if (last) {
    last = (await store.get_task(last.id)) ?? last
  }

  if (cmd.name === "status") {
    const [message, op] = await Promise.all([store.get_conn("message"), store.get_conn("opencode")])
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "card",
        body: {
          ...status_card({
            row: last,
            current,
            pref,
            conf,
            syncd,
            message,
            opencode: op,
          }),
          template: "blue",
        },
      },
    })
    return true
  }

  if (cmd.name === "session") {
    if (!cmd.arg) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: [
              `当前会话：${current?.session_id ?? "未创建"}`,
              `目录：${repo(current?.directory, current?.workspace_id)}`,
              `模型：${model(current?.model ?? conf.opencode.model)}`,
              "使用 /session <session_id> 切换当前会话。",
            ].join("\n"),
          },
        },
      })
      return true
    }

    const next = await opencode.session(cmd.arg)
    if (!next) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: { text: `未找到会话：${cmd.arg}` },
        },
      })
      return true
    }

    if (current?.session_id === next.id) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: [`当前已在该会话。`, `session: ${next.id}`, `目录：${repo(next.directory, next.workspace_id)}`].join("\n"),
          },
        },
      })
      return true
    }

    const item = await route.switch({
      tenant_id: inbound.tenant_id,
      chat_id: inbound.chat_id,
      chat_type: inbound.chat_type,
      thread_id: inbound.thread_id,
      root_message_id: inbound.root_message_id,
      user_id: inbound.user_id,
      session: next,
    })
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: [`已切换当前会话。`, `session: ${item.session_id}`, `目录：${repo(item.directory, item.workspace_id)}`, `模型：${model(item.model ?? conf.opencode.model)}`].join("\n"),
        },
      },
    })
    await replay_waiting(store, task, feishu, render, await store.get_last_task(item.session_id), item.chat_id)
    return true
  }

  if (cmd.name === "sessions") {
    const [list, status, tasks] = await Promise.all([
      opencode.sessions({
        directory: base.directory,
        roots: true,
        limit: 8,
      }),
      opencode.status(base),
      store.list_tasks(),
    ])
    const local = [...latest(tasks).values()].reduce((map, row) => {
      map[row.session_id] = row.status
      return map
    }, {} as Record<string, Task["status"] | undefined>)
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: sessions(list, status, local, base.directory, current?.session_id),
        },
      },
    })
    return true
  }

  if (cmd.name === "skills") {
    const list = await opencode.skills(base)
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: skills(list),
        },
      },
    })
    return true
  }

  if (cmd.name === "agents") {
    const list = await opencode.agents(base)
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: agents(list),
        },
      },
    })
    return true
  }

  if (cmd.name === "models") {
    const list = await opencode.providers(base)
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: models(list),
        },
      },
    })
    return true
  }

  if (cmd.name === "model") {
    if (!cmd.arg) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: [`当前模型：${model(current?.model ?? conf.opencode.model)}`, `默认模型：${model(conf.opencode.model)}`, current?.session_id ? `session: ${current.session_id}` : "session: 未创建", "使用 /model <provider>/<model_id> 切换当前模型，或 /model reset 恢复默认。"].join("\n"),
          },
        },
      })
      return true
    }

    if (last && live(last.status)) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text:
              syncd === "unknown" && active(last.status)
                ? "暂时无法确认当前执行状态，请稍候再试，或先发送 /abort 终止。"
                : "当前有执行中的任务，暂时不能切换模型。",
          },
        },
      })
      return true
    }

    const item =
      current ??
      (await route.resolve({
        tenant_id: inbound.tenant_id,
        chat_id: inbound.chat_id,
        chat_type: inbound.chat_type,
        thread_id: inbound.thread_id,
        root_message_id: inbound.root_message_id,
        user_id: inbound.user_id,
      }))

    if (cmd.arg === "reset") {
      await route.model({
        session_id: item.session_id,
        model: undefined,
      })
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: [`已恢复默认模型。`, `当前模型：${model(conf.opencode.model)}`, `session: ${item.session_id}`].join("\n"),
          },
        },
      })
      return true
    }

    const at = cmd.arg.indexOf("/")
    const pid = at > 0 ? cmd.arg.slice(0, at) : ""
    const mid = at > 0 ? cmd.arg.slice(at + 1) : ""
    if (!pid || !mid) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: { text: "模型格式应为 <provider>/<model_id>，例如 /model cba_openai/gpt-5.4" },
        },
      })
      return true
    }

    const list = await opencode.providers(base)
    const hit = list.find((item) => item.id === pid)
    if (!hit || !hit.models.some((item) => item.id === mid)) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: { text: `当前没有可用模型：${pid}/${mid}` },
        },
      })
      return true
    }

    await route.model({
      session_id: item.session_id,
      model: {
        providerID: pid,
        modelID: mid,
      },
    })
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: [`已切换当前模型。`, `当前模型：${pid}/${mid}`, `session: ${item.session_id}`].join("\n"),
        },
      },
    })
    return true
  }

  if (cmd.name === "mcps") {
    const list = await opencode.mcps(base)
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: mcps(list),
        },
      },
    })
    return true
  }

  if (cmd.name === "commands") {
    const list = await opencode.commands(base)
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: commands(list),
        },
      },
    })
    return true
  }

  if (cmd.name === "abort") {
    if (!current || !last || !live(last.status)) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: { text: "当前没有可取消的执行。" },
        },
      })
      return true
    }
    if (last.status === "waiting_permission" && last.req) {
      await opencode.allow({
        req: last.req,
        reply: "reject",
        directory: current.directory,
        workspace: current.workspace_id,
      })
      await task.abort(last.id, "已拒绝当前权限请求并取消执行。")
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: { text: "已拒绝当前权限请求并取消执行。" },
        },
      })
      return true
    }
    if (last.status === "waiting_question" && last.req) {
      await opencode.reject({
        req: last.req,
        directory: current.directory,
        workspace: current.workspace_id,
      })
      await task.abort(last.id, "已取消当前补充问题并终止执行。")
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: { text: "已取消当前补充问题并终止执行。" },
        },
      })
      return true
    }
    if (last.status === "waiting_attachment") {
      await store.drop_task_pending(last.id)
      await task.abort(last.id, "已取消等待中的附件上下文。")
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: { text: "已取消等待中的附件上下文。" },
        },
      })
      return true
    }
    await opencode.abort({
      session_id: current.session_id,
      directory: current.directory,
      workspace: current.workspace_id,
    })
    await task.abort(last.id, "已发送取消请求。")
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: { text: "已发送取消请求。" },
      },
    })
    return true
  }

  if (cmd.name === "new") {
    const next = await route.reset({
      tenant_id: inbound.tenant_id,
      chat_id: inbound.chat_id,
      chat_type: inbound.chat_type,
      thread_id: inbound.thread_id,
      root_message_id: inbound.root_message_id,
      user_id: inbound.user_id,
    })
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: [`已创建新会话。`, `目录：${repo(next.directory, next.workspace_id)}`].join("\n"),
        },
      },
    })
    return true
  }

  if (cmd.name === "repo") {
    if (cmd.scope === "chat") {
      if (!cmd.arg && !cmd.workspace) {
        await feishu.reply({
          msg_id: inbound.message_id,
          out: {
            kind: "text",
            body: { text: `当前聊天默认绑定：${repo(pref.chat?.directory, pref.chat?.workspace_id)}` },
          },
        })
        return true
      }
      await store.save_pref({
        scope: "chat",
        tenant_id: inbound.tenant_id,
        chat_id: inbound.chat_id,
        directory: cmd.arg ?? pref.chat?.directory,
        workspace_id: cmd.workspace ?? pref.chat?.workspace_id,
      })
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: `已设置当前聊天默认绑定：${repo(cmd.arg ?? pref.chat?.directory, cmd.workspace ?? pref.chat?.workspace_id)}`,
          },
        },
      })
      return true
    }

    if (cmd.scope === "user") {
      if (!cmd.arg && !cmd.workspace) {
        await feishu.reply({
          msg_id: inbound.message_id,
          out: {
            kind: "text",
            body: { text: `当前用户默认绑定：${repo(pref.user?.directory, pref.user?.workspace_id)}` },
          },
        })
        return true
      }
      await store.save_pref({
        scope: "user",
        tenant_id: inbound.tenant_id,
        user_id: inbound.user_id,
        directory: cmd.arg ?? pref.user?.directory,
        workspace_id: cmd.workspace ?? pref.user?.workspace_id,
      })
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: `已设置当前用户默认绑定：${repo(cmd.arg ?? pref.user?.directory, cmd.workspace ?? pref.user?.workspace_id)}`,
          },
        },
      })
      return true
    }

    if (!cmd.arg && !cmd.workspace) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: [
              `当前目录：${repo(current?.directory, current?.workspace_id)}`,
              `聊天默认：${repo(pref.chat?.directory, pref.chat?.workspace_id)}`,
              `用户默认：${repo(pref.user?.directory, pref.user?.workspace_id)}`,
            ].join("\n"),
          },
        },
      })
      return true
    }
    const item =
      current ??
      (await route.resolve({
        tenant_id: inbound.tenant_id,
        chat_id: inbound.chat_id,
        chat_type: inbound.chat_type,
        thread_id: inbound.thread_id,
        root_message_id: inbound.root_message_id,
        user_id: inbound.user_id,
      }))
    if (current && last?.status === "waiting_attachment") {
      await store.drop_task_pending(last.id)
      await task.abort(last.id)
    }
    const next = await route.bind({
      session_id: item.session_id,
      directory: cmd.arg,
      workspace_id: cmd.workspace,
    })
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text: [
            `已绑定：${repo(next?.directory ?? cmd.arg, next?.workspace_id ?? cmd.workspace)}`,
            next && next.session_id !== item.session_id ? "已切换到新会话。" : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    })
    return true
  }

  if (cmd.name === "slash") {
    const list = await opencode.commands(base)
    const hit = list.find((item) => item.name === cmd.command)
    if (!hit) {
      const near = similar(list, cmd.command)
      await feishu.reply({
        msg_id: inbound.message_id,
        out: {
          kind: "text",
          body: {
            text: [
              `命令不存在：/${cmd.command}`,
              near.length > 0 ? `你可能想用：${near.map((item) => `/${item.name}`).join("、")}` : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      })
      return true
    }

    if (last && (wait(last.status) || (active(last.status) && syncd !== "resumable"))) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: render.progress({
          text:
            syncd === "unknown" && active(last.status)
              ? "暂时无法确认上一条消息状态，请稍候再试，或发送 /abort 终止。"
              : "上一条消息还在处理中，请稍候再发下一条。",
        }),
      })
      return true
    }

    let item =
      current ??
      (await route.resolve({
        tenant_id: inbound.tenant_id,
        chat_id: inbound.chat_id,
        chat_type: inbound.chat_type,
        thread_id: inbound.thread_id,
        root_message_id: inbound.root_message_id,
        user_id: inbound.user_id,
      }))
    const row = last && active(last.status) && syncd === "resumable"
      ? await rebind_task(store, task, last, item, inbound)
      : await task.add({
          im_session_id: item.id,
          session_id: item.session_id,
          inbound_id: inbound.id,
          reply_anchor_message_id: inbound.message_id,
          directory: item.directory,
          workspace_id: item.workspace_id,
        })
    await task.ack(row.id)
    await task.run(row.id)
    const out = render.ack({
      text: `执行命令 /${hit.name}${cmd.arguments ? ` ${cmd.arguments}` : ""}`,
    })
    await deliver(store, task, feishu, row, item.chat_id, out, ack_meta)
    await task.note({
      id: row.id,
      note: `执行命令 /${hit.name}${cmd.arguments ? ` ${cmd.arguments}` : ""}`,
    })
    await opencode
      .command({
        session_id: item.session_id,
        command: hit.name,
        arguments: cmd.arguments,
        directory: item.directory,
        workspace: item.workspace_id,
      })
      .then(async (val) => {
        const out = render.final({
          text: val || `已执行 /${hit.name}。`,
        })
        await publish(store, task, feishu, item.session_id, item.chat_id, out, undefined, row, final_meta)
        await task.done(row.id, val || `已执行 /${hit.name}。`)
      })
      .catch(async (err) => {
        const val = raw(err)
        await task.fail({
          id: row.id,
          err: val,
        })
        const out = render.err({
          text: explain(val),
        })
        await publish(store, task, feishu, item.session_id, item.chat_id, out, undefined, row, error_meta)
      })
    return true
  }

  return false
}

export async function on_event(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  event: OpencodeEvent,
) {
  if (event.type === "permission.asked") {
    const session_id = String(event.properties.sessionID ?? "")
    const req = String(event.properties.id ?? "")
    const row = await claim_waiting_task(store, session_id, req)
    if (!row || done(row.status)) return
    const to = await dest(store, row, session_id)
    if (!to) return
    await once(store, event, row, async () => {
      const tool = String(event.properties.permission ?? "tool")
      const detail = JSON.stringify(event.properties.metadata ?? {})
      const visible = await foreground(store, row)
      const queued = await queue_wait(store, row, {
        kind: "approval",
        req,
        visible,
        payload: {
          tool,
          detail,
        },
      })
      const current = await sync_wait_head(store, row, await head_wait(store, row))
      if (!queued.became_head || !visible) return
      await mark_visible_wait(store, current)
      await flush_next_request(store, task, feishu, render, session_id, to.chat_id)
    })
    return
  }

  if (event.type === "question.asked") {
    const session_id = String(event.properties.sessionID ?? "")
    const req = String(event.properties.id ?? "")
    const row = await claim_waiting_task(store, session_id, req)
    if (!row || done(row.status)) return
    const to = await dest(store, row, session_id)
    if (!to) return
    await once(store, event, row, async () => {
      const list = Array.isArray(event.properties.questions) ? event.properties.questions : []
      const item = list[0] as Question | undefined
      const title = item?.question ?? "Please provide more context"
      const opts = item?.options?.map((opt) => opt.label ?? "").filter(Boolean) ?? []
      const custom = item?.custom ?? true
      const visible = await foreground(store, row)
      const queued = await queue_wait(store, row, {
        kind: "question",
        req,
        visible,
        payload: {
          title,
          opts,
          custom,
        },
      })
      const current = await sync_wait_head(store, row, await head_wait(store, row))
      if (!queued.became_head || !visible) return
      await mark_visible_wait(store, current)
      await flush_next_request(store, task, feishu, render, session_id, to.chat_id)
    })
    return
  }

  if (event.type === "session.error") {
    const session_id = String(event.properties.sessionID ?? "")
    const row = await store.get_last_task(session_id)
    if (done(row?.status)) return
    const to = await dest(store, row, session_id)
    if (!to) return
    await once(store, event, row, async () => {
      const err = errtext(event.properties.error)
      if (row) {
        await task.fail({
          id: row.id,
          err,
        })
      }
      await publish(
        store,
        task,
        feishu,
        session_id,
        to.chat_id,
        render.err({
          text: explain(err),
        }),
        undefined,
        row ?? undefined,
        error_meta,
      )
    })
    return
  }

  if (event.type === "session.status") {
    const session_id = String(event.properties.sessionID ?? "")
    const row = await store.get_last_task(session_id)
    if (!row || done(row.status) || wait(row.status)) return
    const to = await dest(store, row, session_id)
    if (!to) return
    const status = event.properties.status as
      | { type?: string; attempt?: number; message?: string }
      | undefined
    if (status?.type !== "idle") return

    await reconcile_non_wait(store, task, feishu, render, opencode, row, to, {
      empty_text: "当前会话已结束，但没有可恢复结果，请重新发送上一条消息。",
    })
    return
  }

}

export async function on_progress(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  render: ReturnType<typeof createRender>,
  tick: Progress,
  event: OpencodeEvent,
) {
  if (event.type === "session.status") {
    const session_id = String(event.properties.sessionID ?? "")
    const row = session_id ? await visible_task(store, session_id) : null
    if (row?.status === "aborted") return false
    if (wait(row?.status)) return false
    if (row && !active(row.status)) return false
    const status = event.properties.status as { type?: string } | undefined
    if (status?.type === "idle") return false
    const to = await dest(store, row, session_id)
    if (!to) return false
    if (status?.type === "busy") {
      await once(store, event, row, async () => {
        if (row) {
          await task.note({
            id: row.id,
            note: "正在处理",
          })
        }
        await tick.push(
          session_id,
          to.chat_id,
          render.progress({
            text: "正在处理，请稍候…",
          }),
          progress_meta,
        )
      })
      return true
    }
    if (status?.type === "retry") {
      const info = event.properties.status as { attempt?: number; message?: string }
      await once(store, event, row, async () => {
        if (row) {
          await task.note({
            id: row.id,
            note: `重试第 ${info.attempt ?? 0} 次：${info.message ?? "模型正在重试"}`,
          })
        }
        await tick.push(
          session_id,
          to.chat_id,
          render.progress({
            step: `重试第 ${info.attempt ?? 0} 次`,
            text: info.message ?? "模型正在重试",
          }),
          progress_meta,
        )
      })
      return true
    }
    return false
  }

  if (event.type === "message.updated") {
    const session_id = String(event.properties.sessionID ?? "")
    const row = session_id ? await visible_task(store, session_id) : null
    if (row?.status === "aborted") return false
    if (wait(row?.status)) return false
    if (!row || !active(row.status)) return false
    const to = await dest(store, row, session_id)
    if (!to) return false
    const info = event.properties.info as { role?: string; agent?: string; modelID?: string } | undefined
    if (info?.role !== "assistant") return false
    const title = [info.agent, info.modelID].filter(Boolean).join(" / ")
    await once(store, event, row, async () => {
      await task.note({
        id: row.id,
        note: title ? `开始处理: ${title}` : "开始处理",
      })
      await tick.push(
        session_id,
        to.chat_id,
        render.progress({
          step: title ? `开始处理: ${title}` : "开始处理",
          text: "正在生成回复…",
        }),
        progress_meta,
      )
    })
    return true
  }

  if (event.type === "message.part.updated") {
    const session_id = String(event.properties.sessionID ?? "")
    const row = session_id ? await visible_task(store, session_id) : null
    if (row?.status === "aborted") return false
    if (wait(row?.status)) return false
    if (!row || !active(row.status)) return false
    const to = await dest(store, row, session_id)
    if (!to) return false
    const part = event.properties.part
    if (!part || typeof part !== "object") return false
    const val = step(part as Record<string, unknown>)
    if (!val) return false
    await once(store, event, row, async () => {
      await task.note({
        id: row.id,
        note: val,
      })
      await tick.push(
        session_id,
        to.chat_id,
        render.progress({
          step: val,
          text: "处理中…",
        }),
        progress_meta,
      )
    })
    return true
  }

  return false
}

export async function dispatch_event(
  store: Store,
  task: ReturnType<typeof createTaskSvc>,
  feishu: ReturnType<typeof createFeishuApi>,
  render: ReturnType<typeof createRender>,
  opencode: ReturnType<typeof createOpencodeSvc>,
  tick: Stream,
  item: OpencodeEvent,
) {
  if (item.type === "permission.asked" || item.type === "question.asked") {
    const session_id = String(item.properties.sessionID ?? "")
    if (session_id) await tick.flush(session_id)
    await on_event(store, task, feishu, render, opencode, item)
    return
  }

  if (await on_progress(store, task, render, tick, item)) return

  if (item.type === "session.error" || item.type === "session.status") {
    const session_id = String(item.properties.sessionID ?? "")
    if (session_id) await tick.flush(session_id)
  }

  await on_event(store, task, feishu, render, opencode, item)
}

export async function on_msg(
  conf: AppCfg,
  route: SessionSvc,
  task: TaskSvc,
  store: Store,
  feishu: FeishuApi,
  render: Render,
  opencode: OpencodeSvc,
  inbound: InboundMessage,
) {
  const val = body(inbound)
  const current = await store.get_session({
    tenant_id: inbound.tenant_id,
    chat_id: inbound.chat_id,
    thread_id: inbound.thread_id,
  })
  let last = current ? await store.get_last_task(current.session_id) : null
  const pend = current && last?.status === "waiting_attachment" ? await store.get_task_pending(last.id) : null
  if (last?.status === "waiting_attachment" && !pend) {
    await task.fail({
      id: last.id,
      err: "附件上下文已丢失，本次消息将按新的请求处理。",
    })
    last = (await store.get_task(last.id)) ?? last
  }
  if (!val && inbound.assets.length === 0 && !(last?.status === "waiting_attachment" && pend)) {
    await feishu.reply({
      msg_id: inbound.message_id,
      out: {
        kind: "text",
        body: {
          text:
            inbound.message_type && inbound.message_type !== "text"
              ? "当前消息里没有可处理的文本或附件，请直接发送文本、图片、文件或图文消息。"
              : "请直接提问，或发送 /help 查看可用命令。",
        },
      },
    })
    return
  }
  if (await on_cmd(val, conf, route, task, store, feishu, render, opencode, inbound)) return
  let item = await route.resolve({
    tenant_id: inbound.tenant_id,
    chat_id: inbound.chat_id,
    chat_type: inbound.chat_type,
    thread_id: inbound.thread_id,
    root_message_id: inbound.root_message_id,
    user_id: inbound.user_id,
  })
  let prev = current ? last : await store.get_last_task(item.session_id)
  const front = await next_waiting_request(store, item.session_id)
  if (front) prev = front
  const syncd = prev && active(prev.status) ? await probe(conf, store, task as ReturnType<typeof createTaskSvc>, feishu as ReturnType<typeof createFeishuApi>, render as ReturnType<typeof createRender>, opencode as ReturnType<typeof createOpencodeSvc>, prev, true) : undefined
  if (prev) {
    prev = (await store.get_task(prev.id)) ?? prev
  }
  const hold = prev?.status === "waiting_attachment" ? await store.get_task_pending(prev.id) : null

  if (prev?.status === "waiting_attachment" && !hold) {
    await task.fail({
      id: prev.id,
      err: "附件上下文已丢失，本次消息将按新的请求处理。",
    })
  }

  if (prev?.status === "waiting_attachment" && hold) {
    const list = [...hold.assets, ...(await fetch(store, feishu, inbound))]

    if (!val) {
      if (list.length === hold.assets.length) {
        await feishu.reply({
          msg_id: inbound.message_id,
          out: render.progress({
            text: "已在等待你的补充说明，请再发一句你希望我做什么。",
          }),
        })
        return
      }
      await store.save_task_pending({
        ...hold,
        assets: list,
        updated_at: Date.now(),
      })
      await publish(
        store,
        task as ReturnType<typeof createTaskSvc>,
        feishu as ReturnType<typeof createFeishuApi>,
        item.session_id,
        item.chat_id,
        render.progress({
          text: moremsg(list.slice(hold.assets.length), list),
        }),
        undefined,
        prev,
        attachment_meta,
      )
      await task.note({
        id: prev.id,
        note: `等待补充说明，已累计 ${count(list)}`,
      })
      return
    }

    await task.run(prev.id)
    await publish(
      store,
      task as ReturnType<typeof createTaskSvc>,
      feishu as ReturnType<typeof createFeishuApi>,
      item.session_id,
      item.chat_id,
      render.progress({
        text: "已提交补充说明",
      }),
      undefined,
      prev,
      progress_meta,
    )
    await opencode
      .prompt({
        session_id: item.session_id,
        parts: parts(val, list),
        directory: item.directory,
        workspace: item.workspace_id,
        ...(item.model ? { model: item.model } : {}),
      })
      .then(async () => {
        await store.drop_task_pending(prev.id)
      })
      .catch(async (err) => {
        const val = raw(err)
        await store.drop_task_pending(prev.id)
        await task.fail({
          id: prev.id,
          err: val,
        })
        const out = render.err({
          text: explain(val),
        })
        await publish(
          store,
          task as ReturnType<typeof createTaskSvc>,
          feishu as ReturnType<typeof createFeishuApi>,
          item.session_id,
          item.chat_id,
          out,
          undefined,
          prev,
          error_meta,
        )
        throw err
      })
    return
  }

  if (prev?.status === "waiting_question" && prev.req) {
    if (!val) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: render.progress({
          text: "当前这一步需要文字回答，请直接发送文本内容。",
        }),
      })
      return
    }
    const meta = qmeta(prev.note)
    const list = meta?.opts ?? []
    const pickd = pick(val, list)
    if (list.length > 0 && !pickd && !meta?.custom) {
      await feishu.reply({
        msg_id: inbound.message_id,
        out: render.progress({
          text: "当前这一步请直接回复序号，例如 1；如需多选，可回复 1,2。",
        }),
      })
      return
    }
    const answers = pickd ? [pickd] : [[val]]
    await task.run(prev.id)
    await resolve_wait(store, prev, prev.req)
    await publish(
      store,
      task as ReturnType<typeof createTaskSvc>,
      feishu as ReturnType<typeof createFeishuApi>,
      item.session_id,
      item.chat_id,
      render.progress({
        text: "已提交补充信息",
      }),
      undefined,
      prev,
      progress_meta,
    )
    await opencode.answer({
      req: prev.req,
      answers,
      directory: item.directory,
      workspace: item.workspace_id,
    })
    await flush_next_request(
      store,
      task as ReturnType<typeof createTaskSvc>,
      feishu as ReturnType<typeof createFeishuApi>,
      render as ReturnType<typeof createRender>,
      item.session_id,
      item.chat_id,
    )
    return
  }

  if (prev?.status === "waiting_permission" && prev.req) {
    const reply = val ? permit(val) : undefined
    if (!reply) {
      if (val) {
        await task.run(prev.id)
        await resolve_wait(store, prev, prev.req)
        await task.note({
          id: prev.id,
          note: "已收到更正说明，正在继续执行…",
        })
        await publish(
          store,
          task as ReturnType<typeof createTaskSvc>,
          feishu as ReturnType<typeof createFeishuApi>,
          item.session_id,
          item.chat_id,
          render.progress({
            text: "已收到你的更正说明，正在继续执行…",
          }),
          undefined,
          prev,
          progress_meta,
        )
        await opencode.allow({
          req: prev.req,
          reply: "reject",
          message: val,
          directory: item.directory,
          workspace: item.workspace_id,
        })
        await flush_next_request(
          store,
          task as ReturnType<typeof createTaskSvc>,
          feishu as ReturnType<typeof createFeishuApi>,
          render as ReturnType<typeof createRender>,
          item.session_id,
          item.chat_id,
        )
        return
      }
      await feishu.reply({
        msg_id: inbound.message_id,
        out: render.progress({
          text: "当前在等待权限审批，请回复 1、2、3；如果你想更正本次操作，也可以直接发送文本。",
        }),
      })
      return
    }
    if (reply === "reject") {
      await resolve_wait(store, prev, prev.req)
      await task.run(prev.id)
    } else {
      await task.run(prev.id)
      await resolve_wait(store, prev, prev.req)
    }
    await publish(
      store,
      task as ReturnType<typeof createTaskSvc>,
      feishu as ReturnType<typeof createFeishuApi>,
      item.session_id,
      item.chat_id,
      render.progress({
        text:
          reply === "always" ? "已始终允许，正在继续执行…" : reply === "reject" ? "已拒绝当前权限请求。" : "已允许一次，正在继续执行…",
      }),
      undefined,
      prev,
      progress_meta,
    )
    await opencode.allow({
      req: prev.req,
      reply,
      directory: item.directory,
      workspace: item.workspace_id,
    })
    await flush_next_request(
      store,
      task as ReturnType<typeof createTaskSvc>,
      feishu as ReturnType<typeof createFeishuApi>,
      render as ReturnType<typeof createRender>,
      item.session_id,
      item.chat_id,
    )
    return
  }

  if (prev && active(prev.status) && syncd !== "resumable") {
    await feishu.reply({
      msg_id: inbound.message_id,
      out: render.progress({
        text:
          syncd === "unknown"
            ? "暂时无法确认上一条消息状态，请稍候再试，或发送 /abort 终止。"
            : "上一条消息还在处理中，请稍候再发下一条。",
      }),
    })
    return
  }

  const list = await fetch(store, feishu, inbound).catch(async (err) => {
    await feishu.reply({
      msg_id: inbound.message_id,
      out: render.err({
        text: explain(err),
      }),
    })
    return null
  })
  if (!list) return

  const row = prev && active(prev.status) && syncd === "resumable"
    ? await rebind_task(store, task, prev, item, inbound)
    : await task.add({
        im_session_id: item.id,
        session_id: item.session_id,
        inbound_id: inbound.id,
        reply_anchor_message_id: inbound.message_id,
        directory: item.directory,
        workspace_id: item.workspace_id,
      })
  await task.ack(row.id)
  if (!val && list.length > 0) {
    await task.hold(row.id)
    await store.save_task_pending({
      task_id: row.id,
      session_id: item.session_id,
      origin_inbound_id: inbound.id,
      origin_message_id: inbound.message_id,
      assets: list,
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    const out = render.ack({
      text: holdmsg(list),
    })
    await deliver(
      store,
      task as ReturnType<typeof createTaskSvc>,
      feishu as ReturnType<typeof createFeishuApi>,
      row,
      item.chat_id,
      out,
      attachment_meta,
    )
    await task.note({
      id: row.id,
      note: `等待补充说明，已收到 ${count(list)}`,
    })
    return
  }

  await task.run(row.id)
  const out = render.ack({
    text: note(val, list),
  })
  await deliver(
    store,
    task as ReturnType<typeof createTaskSvc>,
    feishu as ReturnType<typeof createFeishuApi>,
    row,
    item.chat_id,
    out,
    ack_meta,
  )
  await task.note({
    id: row.id,
    note: `已收到：${note(val, list)}`,
  })
  await opencode
    .prompt({
      session_id: row.session_id,
      parts: parts(val, list),
      directory: item.directory,
      workspace: item.workspace_id,
      ...(item.model ? { model: item.model } : {}),
    })
    .catch(async (err) => {
      const val = raw(err)
      await task.fail({
        id: row.id,
        err: val,
      })
        const out = render.err({
          text: explain(val),
        })
        await publish(
          store,
          task as ReturnType<typeof createTaskSvc>,
          feishu as ReturnType<typeof createFeishuApi>,
          item.session_id,
          item.chat_id,
          out,
          undefined,
          row,
          error_meta,
        )
        throw err
      })
}

async function housekeep(conf: AppCfg) {
  const asset_dir =
    conf.runtime?.asset_dir ??
    path.join(conf.storage.path === ":memory:" ? path.resolve(process.cwd(), ".data") : path.dirname(conf.storage.path), "asset")
  const backup_dir =
    conf.runtime?.backup_dir ??
    path.join(conf.storage.path === ":memory:" ? path.resolve(process.cwd(), ".data") : path.dirname(conf.storage.path), "backup")
  const asset_ttl_ms = (conf.runtime?.asset_ttl_hours ?? 7 * 24) * 60 * 60 * 1000
  const asset_max_bytes = (conf.runtime?.asset_max_mb ?? 1024) * 1024 * 1024
  const backup_ttl_ms = (conf.runtime?.backup_retention_days ?? 14) * 24 * 60 * 60 * 1000
  const out = await Promise.all([
    cleanupDir(asset_dir, {
      ttl_ms: asset_ttl_ms,
      max_bytes: asset_max_bytes,
    }),
    cleanupDir(backup_dir, {
      ttl_ms: backup_ttl_ms,
    }),
  ])

  for (const item of out) {
    if (item.removed === 0 && item.freed_bytes === 0) continue
    console.log(
      JSON.stringify({
        type: "runtime.cleanup",
        ...item,
      }),
    )
  }
}

export function createApp(conf = cfg()): App {
  const store = createSqliteStore(conf.storage.path)
  const render = createRender()
  const feishu = createFeishuApi({
    ...conf.feishu,
    cache:
      conf.runtime?.asset_dir ??
      path.join(conf.storage.path === ":memory:" ? path.resolve(process.cwd(), ".data") : path.dirname(conf.storage.path), "asset"),
  })
  const opencode = createOpencodeSvc(conf)
  const route = createSessionSvc({
    store,
    opencode,
    directory: conf.opencode.directory,
    workspace: conf.opencode.workspace,
  })
  const task = createTaskSvc(store)
  const tick = createTick(store, task, feishu)
  const watch = createWatch(conf, store, task, feishu, render, opencode)

  const queue = createQueue(
    store,
    async (job) => {
      const inbound = await store.get_inbound(job.id)
      if (!inbound || inbound.kind !== "message") return
      if (await store.get_task_by_inbound(job.id)) return
      if (!(await allow(store, inbound, feishu, conf.feishu.bot_id))) return
      await on_msg(conf, route, task, store, feishu, render, opencode, inbound)
    },
    async (job, err) => {
      const inbound = await store.get_inbound(job.id)
      const row = await store.get_task_by_inbound(job.id)
      const val = raw(err)
      if (row && row.status !== "completed" && row.status !== "failed" && row.status !== "aborted") {
        await task.fail({
          id: row.id,
          err: val,
        })
        const to = await dest(store, row, row.session_id)
        if (!to) return
        await publish(
          store,
          task,
          feishu,
          row.session_id,
          to.chat_id,
          render.err({
            text: explain(val),
          }),
          undefined,
          row,
          error_meta,
        )
        return
      }
      if (inbound?.kind !== "message") return
      await feishu.reply({
        msg_id: inbound.message_id,
        out: render.err({
          text: explain(val),
        }),
      })
    },
  )

  const gateway = createGateway({
    store,
    queue,
  })
  let msgstate: ConnState | null = null
  let opstate: ConnState | null = null

  const conn = createFeishuConn({
    mode: conf.feishu.mode,
    app_id: conf.feishu.app_id,
    app_secret: conf.feishu.app_secret,
    on_msg: gateway.on_msg,
    on_state: async (item) => {
      const prev = msgstate
      msgstate = item
      await on_conn(conf, store, task, feishu, render, opencode, prev, item)
    },
  })

  const event = createOpencodeEvent({
    cfg: conf,
    store,
    on_state: async (item) => {
      const prev = opstate
      opstate = item
      await on_conn(conf, store, task, feishu, render, opencode, prev, item)
    },
    on_event: async (item) => {
      await dispatch_event(store, task, feishu, render, opencode, tick, item)
    },
  })

  return {
    cfg: conf,
    async start() {
      await housekeep(conf).catch((err) => {
        console.warn("[runtime.cleanup]", err instanceof Error ? err.message : String(err))
      })
      await queue.start()
      await event.start()
      await conn.start()
      watch.start()
      await recover(conf, store, task, feishu, render, opencode)
      feishu.sync().catch((err) => {
        console.warn("[feishu.sync]", err instanceof Error ? err.message : String(err))
      })
    },

    async stop() {
      await conn.stop()
      await watch.stop()
      await tick.stop()
      await event.stop()
      await queue.stop()
      await store.close?.()
    },
  }
}
