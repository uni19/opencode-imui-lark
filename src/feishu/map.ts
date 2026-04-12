import crypto from "node:crypto"
import type { Asset, InboundEvent, InboundMessage } from "../contracts.js"

type Raw = {
  event_id?: string
  tenant_id?: string
  chat_id?: string
  chat_type?: string
  thread_id?: string
  user_id?: string
  text?: string
  assets?: Asset[]
  message_id?: string
  root_message_id?: string
  parent_message_id?: string
  message_type?: string
  mentions?: string[]
  mention_names?: string[]
}

type MessageData = {
  event_id?: string
  message?: {
    chat_id?: string
    message_id?: string
    root_id?: string
    parent_id?: string
    thread_id?: string
    chat_type?: string
    message_type?: string
    create_time?: string
    update_time?: string
    content?: string
    mentions?: Array<{
      name?: string
      id?: {
        open_id?: string
      }
    }>
  }
  sender?: {
    sender_id?: {
      open_id?: string
    }
  }
  tenant_key?: string
}

type Content = {
  text: string
  assets: Asset[]
}

const now = () => Date.now()
const id = () => "in_" + crypto.randomUUID()
const event = () => "evt_" + crypto.randomUUID()

function group(chat_type?: string) {
  return chat_type === "group" || chat_type === "group_chat"
}

function thread(
  chat_type: string | undefined,
  thread_id: string | undefined,
  root_id: string | undefined,
  parent_id: string | undefined,
  message_id: string | undefined,
) {
  if (group(chat_type)) return root_id ?? parent_id ?? message_id
  if (thread_id) return thread_id
  if (root_id) return root_id
  if (parent_id) return parent_id
}

function root(
  chat_type: string | undefined,
  root_id: string | undefined,
  parent_id: string | undefined,
  thread_id: string | undefined,
  message_id: string | undefined,
) {
  if (group(chat_type)) return root_id ?? parent_id ?? message_id
  if (root_id) return root_id
  if (parent_id) return parent_id
  if (thread_id) return thread_id
}

function parse(content: string | undefined) {
  if (!content) return
  try {
    return JSON.parse(content) as unknown
  } catch {
    return content
  }
}

function str(val: Record<string, unknown> | undefined, key: string) {
  const item = val?.[key]
  if (typeof item !== "string" || !item) return
  return item
}

function list(val: unknown) {
  return Array.isArray(val) ? val : []
}

function node(val: unknown) {
  if (!val || typeof val !== "object") return
  return val as Record<string, unknown>
}

function empty() {
  return {
    text: "",
    assets: [] as Asset[],
  }
}

function scan(content: string | undefined) {
  const out: Record<string, unknown>[] = []
  const walk = (val: unknown, depth: number) => {
    if (depth > 4) return
    const cur = typeof val === "string" ? node(parse(val)) : node(val)
    if (!cur) return
    out.push(cur)
    walk(cur.content, depth + 1)
    walk(cur.rich_content, depth + 1)
  }
  walk(content, 0)
  return out
}

function body(raw: Record<string, unknown>) {
  const hit = Object.values(raw)
    .map(node)
    .find((item) => Array.isArray(item?.content))
  if (hit) return hit
  if (Array.isArray(raw.content)) return raw
}

function pack(raw: Record<string, unknown>) {
  const text: string[] = []
  const assets: Asset[] = []
  const title = str(raw, "title")
  if (title) text.push(title)

  for (const line of list(raw.content)) {
    const parts: string[] = []
    for (const item of list(line)) {
      const cur = node(item)
      if (!cur) continue
      const tag = str(cur, "tag")
      if (tag === "text") {
        const val = str(cur, "text")
        if (val) parts.push(val)
        continue
      }
      if (tag === "a") {
        const val = str(cur, "text") ?? str(cur, "href")
        if (val) parts.push(val)
        continue
      }
      if (tag === "at") {
        const val = str(cur, "user_name") ?? str(cur, "text")
        if (val) parts.push(`@${val}`)
        continue
      }
      if (tag === "img") {
        const key = str(cur, "image_key")
        if (!key) continue
        assets.push({
          kind: "image",
          key,
          name: `image-${key.slice(0, 8)}.png`,
        })
        continue
      }
      if (tag === "file" || tag === "media") {
        const key = str(cur, "file_key")
        if (!key) continue
        assets.push({
          kind: "file",
          key,
          name: str(cur, "file_name") ?? str(cur, "name") ?? `${tag}-${key.slice(0, 8)}`,
        })
      }
    }
    const val = parts.join("").trim()
    if (val) text.push(val)
  }

  return { text: text.join("\n").trim(), assets } satisfies Content
}

function plain(raw: Record<string, unknown>) {
  const text = str(raw, "text")
  if (text) return text

  const content = str(raw, "content")
  if (typeof parse(content) === "string") return content

  const rich = str(raw, "rich_content")
  if (typeof parse(rich) === "string") return rich
}

function pull(raw: Record<string, unknown>) {
  const out = empty()
  const rich = body(raw)
  if (rich) {
    const item = pack(rich)
    out.text = item.text
    out.assets.push(...item.assets)
  }

  const text = plain(raw)
  if (text && !out.text) out.text = text

  const image = [str(raw, "image_key"), ...list(raw.image_keys).filter((item): item is string => typeof item === "string" && !!item)]
    .filter((item): item is string => !!item)
    .map((key) => ({
      kind: "image" as const,
      key,
      name: `image-${key.slice(0, 8)}.png`,
    }))
  out.assets.push(...image)

  const file = str(raw, "file_key")
  if (file) {
    out.assets.push({
      kind: "file",
      key: file,
      name: str(raw, "file_name") ?? str(raw, "name") ?? `file-${file.slice(0, 8)}`,
    })
  }

  return out
}

function uniq(list: Asset[]) {
  const seen = new Set<string>()
  return list.filter((item) => {
    const key = `${item.kind}:${item.key}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function merge(dst: string[], src: string) {
  for (const item of src.split("\n").map((item) => item.trim()).filter(Boolean)) {
    if (dst.includes(item)) continue
    dst.push(item)
  }
}

function digest(content: string | undefined) {
  const text: string[] = []
  const assets: Asset[] = []
  for (const item of scan(content)) {
    const cur = pull(item)
    merge(text, cur.text)
    assets.push(...cur.assets)
  }

  const plain = parse(content)
  if (text.length === 0 && assets.length === 0 && typeof plain === "string") {
    merge(text, plain)
  }

  return {
    text: text.join("\n").trim(),
    assets: uniq(assets),
  } satisfies Content
}

export function parseInbound(line: string): InboundEvent {
  const raw = JSON.parse(line) as Raw
  return {
    id: id(),
    platform: "feishu" as const,
    event_id: raw.event_id ?? event(),
    tenant_id: raw.tenant_id ?? "tenant.local",
    chat_id: raw.chat_id ?? "chat.local",
    chat_type: raw.chat_type,
    thread_id: thread(raw.chat_type, raw.thread_id, raw.root_message_id, raw.parent_message_id, raw.message_id),
    user_id: raw.user_id ?? "user.local",
    raw,
    created_at: now(),
    kind: "message",
    text: raw.text ?? "",
    assets: raw.assets ?? [],
    message_id: raw.message_id ?? "msg.local",
    root_message_id: raw.root_message_id ?? root(raw.chat_type, raw.root_message_id, raw.parent_message_id, raw.thread_id, raw.message_id),
    parent_message_id: raw.parent_message_id,
    message_type: raw.message_type ?? "text",
    mentions: raw.mentions ?? [],
    mention_names: raw.mention_names ?? [],
  } satisfies InboundMessage
}

export function parseMessage(data: unknown): InboundMessage | null {
  if (!data || typeof data !== "object") return null
  const raw = data as MessageData
  if (!raw.message?.chat_id || !raw.message?.message_id) return null
  const item = digest(raw.message.content)

  return {
    id: id(),
    platform: "feishu",
    kind: "message",
    event_id: raw.event_id ?? [raw.message.message_id, raw.message.create_time ?? ""].join(":"),
    tenant_id: raw.tenant_key ?? "tenant.local",
    chat_id: raw.message.chat_id,
    chat_type: raw.message.chat_type,
    thread_id: thread(
      raw.message.chat_type,
      raw.message.thread_id,
      raw.message.root_id,
      raw.message.parent_id,
      raw.message.message_id,
    ),
    user_id: raw.sender?.sender_id?.open_id ?? "user.local",
    raw: data,
    created_at: now(),
    text: item.text,
    assets: item.assets,
    message_id: raw.message.message_id,
    root_message_id: root(
      raw.message.chat_type,
      raw.message.root_id,
      raw.message.parent_id,
      raw.message.thread_id,
      raw.message.message_id,
    ),
    parent_message_id: raw.message.parent_id,
    message_type: raw.message.message_type,
    mentions: (raw.message.mentions ?? [])
      .map((item) => item.id?.open_id)
      .filter((item): item is string => !!item),
    mention_names: (raw.message.mentions ?? [])
      .map((item) => item.name)
      .filter((item): item is string => !!item),
  }
}
