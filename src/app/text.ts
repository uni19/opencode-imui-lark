import type { AppCfg, ConnState, OpencodeModel, OpencodeResult, RepoPref, Task } from "../contracts.js"

export type RecoverMode = "boot" | "message" | "opencode"

type Prefs = {
  chat: RepoPref | null
  user: RepoPref | null
}

function raw(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function active(status?: string) {
  return status === "queued" || status === "acked" || status === "running" || status === "waiting_permission"
}

function done(status?: string) {
  return status === "completed" || status === "failed" || status === "aborted"
}

function summary(row?: Task | null) {
  if (!row) return "idle"
  return row.status
}

function label(status?: string) {
  if (!status) return "idle"
  if (status === "queued") return "queued（已入队）"
  if (status === "acked") return "acked（已确认）"
  if (status === "running") return "running（处理中）"
  if (status === "waiting_permission") return "waiting_permission（等待权限审批）"
  if (status === "waiting_question") return "waiting_question（等待补充信息）"
  if (status === "waiting_attachment") return "waiting_attachment（等待补充说明）"
  if (status === "completed") return "completed（已完成）"
  if (status === "failed") return "failed（执行失败）"
  if (status === "aborted") return "aborted（已中止）"
  return status
}

export function repo(dir?: string, workspace?: string) {
  const line = dir ? dir : "未绑定"
  if (!workspace) return line
  return `${line} (workspace=${workspace})`
}

export function model(val?: OpencodeModel) {
  if (!val) return "未设置"
  return `${val.providerID}/${val.modelID}`
}

export function qmeta(note?: string) {
  if (!note?.startsWith("question:")) return
  const part = note.split(":", 4)
  const opts = part[3] ? part[3].split("|").map(decodeURIComponent).filter(Boolean) : []
  return {
    custom: part[1] === "1",
    title: decodeURIComponent(part[2] ?? ""),
    opts,
  }
}

export function ameta(note?: string) {
  if (!note?.startsWith("approval:")) return
  const part = note.split(":", 3)
  return {
    tool: decodeURIComponent(part[1] ?? ""),
    detail: decodeURIComponent(part[2] ?? ""),
  }
}

export function short(val?: string) {
  if (!val) return ""
  const text = val.replace(/\s+/g, " ").trim()
  if (text.length <= 48) return text
  return text.slice(0, 45) + "..."
}

export function time(ts?: number) {
  if (!ts) return "-"
  return new Date(ts).toLocaleString("zh-CN", { hour12: false })
}

function view(row?: Task | null) {
  if (!row) return
  if (row.status === "completed") return row.note ?? "已完成"
  if (row.status === "aborted") return row.note ?? "已中止"
  if (row.status === "waiting_permission") {
    const meta = ameta(row.note)
    return `等待权限审批：${meta?.tool ?? "tool"}${meta?.detail ? ` ${short(meta.detail)}` : ""}`
  }
  if (row.status === "waiting_question") {
    const meta = qmeta(row.note)
    if (!meta) return "等待补充信息"
    const opts = meta.opts.slice(0, 3).map((item, i) => `${i + 1}.${item}`).join(" / ")
    if (!opts) return `等待补充信息：${meta.title}`
    return `等待补充信息：${meta.title} (${opts}${meta.opts.length > 3 ? " / ..." : ""})`
  }
  if (row.status === "waiting_attachment") return row.note ?? "等待你补充一句说明"
  if (row.status === "failed" && row.err) return explain(row.err)
  return row.note ? short(row.note) : undefined
}

function conn(item?: ConnState | null) {
  if (!item) return "未建立"
  const head = [item.status, item.attempt ? `#${item.attempt}` : ""].filter(Boolean).join(" ")
  const wait = item.wait_ms && item.status === "reconnecting"
    ? `约 ${Math.max(1, Math.round(item.wait_ms / 1000))} 秒后重试`
    : ""
  const tail = [wait, item.err ? short(friendly(item.err)) : ""].filter(Boolean).join(" - ")
  if (!tail) return head
  return `${head} - ${tail}`
}

function next(
  row?: Task | null,
  syncd?: "busy" | "settled" | "unknown",
  message?: ConnState | null,
  opencode?: ConnState | null,
) {
  if (!row || done(row.status)) return "可直接发送下一条消息。"
  if (row.status === "waiting_permission") return "请回复 1/2/3；如需更正本次操作，也可直接发送文本。"
  if (row.status === "waiting_question") return "可直接回复序号；若问题允许自由回答，也可发送文本。"
  if (row.status === "waiting_attachment") return "请再发一句你希望我做什么。"
  if (opencode?.status === "reconnecting" || opencode?.status === "error") {
    return "当前正在等待 OpenCode 连接恢复，可稍后重试 /status，或发送 /abort 终止。"
  }
  if (message?.status === "reconnecting" || message?.status === "error") {
    return "飞书消息连接暂不稳定，消息同步可能延迟，可稍后重试 /status，或发送 /abort 终止。"
  }
  if (syncd === "unknown") return "暂时无法确认远端状态，可稍后重试 /status，或发送 /abort 终止。"
  return "可稍后再发 /status 查看，或发送 /abort 终止当前执行。"
}

export function stuck(status?: string) {
  return status === "queued" || status === "acked"
    ? "请求还在处理中，如长时间无变化可发送 /status 查看状态，或用 /abort 终止。"
    : "还在处理中，如长时间无变化可发送 /status 查看状态，或用 /abort 终止。"
}

export function done_msg(val: OpencodeResult) {
  if (val.state === "filtered") {
    return "本次执行已完成，但当前只拿到了内部过程或总结信息，没有适合直接展示的最终文本答复。你可以重发一句“请直接给出最终结论”再试一次。"
  }
  return "本次执行已完成，但没有可展示的文本输出。"
}

export function recover_msg(mode: RecoverMode, kind: "approval" | "question" | "attachment" | "cache" | "wait" | "sync" | "queued" | "running") {
  const head = mode === "boot" ? "服务" : mode === "message" ? "飞书消息连接" : "OpenCode 连接"
  if (kind === "approval") return `${head}恢复后，之前的权限审批已失效，请重新发送上一条消息。`
  if (kind === "question") return `${head}恢复后，之前的补充问题已失效，请重新发送上一条消息。`
  if (kind === "attachment") return `${head}恢复后，附件上下文已丢失，请重新发送附件和说明。`
  if (kind === "cache") return `${head}恢复后，附件缓存已失效，请重新发送附件和说明。`
  if (kind === "wait") return `${head}已恢复，仍在等待你的补充说明。`
  if (kind === "sync") return `${head}已恢复，正在继续同步执行状态…`
  if (kind === "queued") return mode === "boot" ? "服务重启时中断，请重新发送上一条消息。" : `${head}恢复后，本次请求已中断，请重新发送上一条消息。`
  return mode === "boot" ? "服务恢复后未能继续本次执行，请重新发送上一条消息。" : `${head}恢复后，本次执行未继续，请重新发送上一条消息。`
}

export function signal_msg(item: ConnState) {
  const head = item.name === "message" ? "飞书消息连接" : "与 OpenCode 的连接"
  if (item.status === "reconnecting") {
    const tail = item.attempt
      ? item.wait_ms
        ? `（第 ${item.attempt} 次，约 ${Math.max(1, Math.round(item.wait_ms / 1000))} 秒后重试）`
        : `（第 ${item.attempt} 次）`
      : ""
    const why = item.err ? ` 原因：${friendly(item.err)}` : ""
    return `${head}暂时中断，正在重连…${tail}${why}`
  }
  if (item.status === "error") return `${head}异常：${friendly(item.err ?? "unknown error")}`
  return `${head}已恢复，继续同步执行状态…`
}

export function status_text(input: {
  row?: Task | null
  current?: { session_id: string; directory?: string; workspace_id?: string; model?: OpencodeModel } | null
  pref: Prefs
  conf: AppCfg
  syncd?: "busy" | "settled" | "unknown"
  message?: ConnState | null
  opencode?: ConnState | null
}) {
  return [
    `会话状态：${label(summary(input.row))}`,
    `目录：${repo(input.current?.directory, input.current?.workspace_id)}`,
    `当前模型：${model(input.current?.model ?? input.conf.opencode.model)}`,
    `默认模型：${model(input.conf.opencode.model)}`,
    `聊天默认：${repo(input.pref.chat?.directory, input.pref.chat?.workspace_id)}`,
    `用户默认：${repo(input.pref.user?.directory, input.pref.user?.workspace_id)}`,
    `飞书连接：${conn(input.message)}`,
    `OpenCode 连接：${conn(input.opencode)}`,
    input.row ? `最近更新：${time(input.row.updated_at)}` : undefined,
    view(input.row) ? `最近进展：${view(input.row)}` : undefined,
    `下一步：${next(input.row, input.syncd, input.message, input.opencode)}`,
    input.syncd === "unknown" && input.row && active(input.row.status) ? "状态探测：暂时无法确认远端状态" : undefined,
    `session: ${input.current?.session_id ?? "未创建"}`,
  ]
    .filter(Boolean)
    .join("\n")
}

export function friendly(err: unknown): string {
  const val = raw(err).trim()
  const low = val.toLowerCase()
  if (!val) return "发生未知错误，请稍后重试。"
  if (low.startsWith("attachment fetch failed:")) {
    const item = /^attachment fetch failed:\s*(.+?)\s*-\s*(.+)$/i.exec(val)
    if (!item) return "附件下载失败：无法从飞书读取附件，请稍后重试。"
    return `附件下载失败（${item[1]}）：${friendly(item[2])}`
  }
  if (low.includes("feishu asset failed: 404")) return "附件下载失败：资源不存在、已失效，或当前消息上下文已不可访问。"
  if (low.includes("feishu asset failed: 400")) return "附件下载失败：附件参数不合法，或资源类型与消息内容不匹配。"
  if (low.includes("feishu asset failed:")) return "附件下载失败：无法从飞书读取附件，请稍后重试。"
  if (
    low.includes("unknown certificate") ||
    low.includes("self signed certificate") ||
    low.includes("unable to verify") ||
    low.includes("certificate")
  ) {
    return "网络请求失败：证书校验失败，请检查代理、HTTPS 证书或企业网关配置。"
  }
  if (low.includes("timed out") || low.includes("timeout") || low.includes("etimedout") || low.includes("aborterror")) {
    return "请求超时：服务长时间没有响应，请稍后重试。"
  }
  if (low.includes("opencode request failed: 404")) return "OpenCode 接口不可用：请检查服务地址、接口版本或 base_url 配置。"
  if (low.includes("opencode request failed: 429") || low.includes("rate limit") || low.includes("too many requests")) {
    return "模型请求过于频繁：已触发限流，请稍后重试。"
  }
  if (low.includes("resource_exhausted") || low.includes("rate_limit_exceeded")) {
    return "模型请求过于频繁：已触发限流，请稍后重试。"
  }
  if (low.includes("insufficient_quota") || low.includes("quota exceeded") || low.includes("billing hard limit")) {
    return "模型额度不足：请检查 provider 配额、账单或项目额度配置。"
  }
  if (
    low.includes("overloaded_error") ||
    low.includes("model is overloaded") ||
    low.includes("server overloaded") ||
    low.includes("service unavailable")
  ) {
    return "模型服务繁忙：请稍后重试，或切换到其他模型。"
  }
  if (low.includes("invalid_api_key") || low.includes("api key not valid")) {
    return "认证失败：请检查 OpenCode 或飞书的账号、密码和权限配置。"
  }
  if (
    low.includes("context length") ||
    low.includes("maximum context") ||
    low.includes("prompt is too long") ||
    low.includes("too many tokens")
  ) {
    return "模型请求失败：上下文过长，请缩短问题、减少附件，或拆成多轮发送。"
  }
  if (
    low.includes("model not found") ||
    low.includes("model_not_found") ||
    low.includes("unknown model") ||
    low.includes("unsupported model") ||
    low.includes("invalid model")
  ) {
    return "模型不可用：请检查当前 provider/model 配置，或切换到可用模型。"
  }
  if (
    low.includes("opencode request failed: 500") ||
    low.includes("opencode request failed: 502") ||
    low.includes("opencode request failed: 503") ||
    low.includes("opencode request failed: 504")
  ) {
    return "OpenCode 服务异常：服务端暂时不可用，请稍后重试。"
  }
  if (low.includes("opencode request failed: 400")) {
    return "模型请求失败：请求参数不合法，或当前会话状态不允许此操作。"
  }
  if (
    low.includes("401") ||
    low.includes("403") ||
    low.includes("unauthorized") ||
    low.includes("forbidden") ||
    low.includes("authentication")
  ) {
    return "认证失败：请检查 OpenCode 或飞书的账号、密码和权限配置。"
  }
  if (low.includes("feishu api failed: 400") || low.includes("bad request")) {
    return "飞书接口请求失败：请求格式、卡片内容或目标消息状态不符合当前接口要求。"
  }
  if (
    low.includes("econnrefused") ||
    low.includes("enotfound") ||
    low.includes("eai_again") ||
    low.includes("fetch failed") ||
    low.includes("network") ||
    low.includes("socket") ||
    low.includes("connection") ||
    low.includes("tls")
  ) {
    return "网络请求失败：无法连接到服务，请检查服务地址、网络、代理或 TLS 配置。"
  }
  return val
}

function advice(err: unknown) {
  const val = raw(err).trim()
  const low = val.toLowerCase()
  const base = friendly(err)
  if (
    base.includes("请重新发送上一条消息") ||
    base.includes("请重新发送附件和说明") ||
    base.includes("发送 /abort") ||
    base.includes("请再发一句你希望我做什么") ||
    base.includes("请直接发送文本内容") ||
    base.includes("请直接回复序号")
  ) {
    return
  }
  if (low.startsWith("attachment fetch failed:") || low.includes("feishu asset failed: 404") || low.includes("feishu asset failed: 400")) {
    return "建议：请重新发送附件和说明，再试一次。"
  }
  if (low.includes("timed out") || low.includes("timeout") || low.includes("etimedout") || low.includes("aborterror")) {
    return "建议：可稍后重试当前请求，一般不需要重发上一条消息。"
  }
  if (
    low.includes("opencode request failed: 429") ||
    low.includes("rate limit") ||
    low.includes("too many requests") ||
    low.includes("resource_exhausted") ||
    low.includes("rate_limit_exceeded") ||
    low.includes("overloaded_error") ||
    low.includes("model is overloaded") ||
    low.includes("server overloaded") ||
    low.includes("service unavailable") ||
    low.includes("opencode request failed: 500") ||
    low.includes("opencode request failed: 502") ||
    low.includes("opencode request failed: 503") ||
    low.includes("opencode request failed: 504")
  ) {
    return "建议：可稍后重试当前请求，一般不需要重发上一条消息。"
  }
  if (
    low.includes("unknown certificate") ||
    low.includes("self signed certificate") ||
    low.includes("unable to verify") ||
    low.includes("certificate") ||
    low.includes("econnrefused") ||
    low.includes("enotfound") ||
    low.includes("eai_again") ||
    low.includes("fetch failed") ||
    low.includes("network") ||
    low.includes("socket") ||
    low.includes("connection") ||
    low.includes("tls")
  ) {
    return "建议：先检查网络、代理或 TLS 配置；若只是瞬时抖动，也可稍后重试当前请求。"
  }
  if (
    low.includes("context length") ||
    low.includes("maximum context") ||
    low.includes("prompt is too long") ||
    low.includes("too many tokens")
  ) {
    return "建议：请缩短问题、减少附件或拆成多轮后，再重新发送。"
  }
  if (low.includes("opencode request failed: 400")) {
    return "建议：当前会话状态或请求参数可能异常，可先发送 /abort，再重试或重发上一条消息。"
  }
  if (low.includes("feishu api failed: 400") || low.includes("bad request")) {
    return "建议：请稍后重试；若持续失败，请检查卡片内容或目标消息是否仍可更新。"
  }
  if (
    low.includes("invalid_api_key") ||
    low.includes("api key not valid") ||
    low.includes("401") ||
    low.includes("403") ||
    low.includes("unauthorized") ||
    low.includes("forbidden") ||
    low.includes("authentication") ||
    low.includes("insufficient_quota") ||
    low.includes("quota exceeded") ||
    low.includes("billing hard limit") ||
    low.includes("model not found") ||
    low.includes("model_not_found") ||
    low.includes("unknown model") ||
    low.includes("unsupported model") ||
    low.includes("invalid model") ||
    low.includes("opencode request failed: 404")
  ) {
    return "建议：请先检查模型、凭证、配额或服务配置，修复后再重试。"
  }
  return "建议：可稍后重试；若仍失败，请重新发送上一条消息。"
}

export function explain(err: unknown) {
  const base = friendly(err)
  const hint = advice(err)
  if (!hint) return base
  return `${base}\n\n${hint}`
}
