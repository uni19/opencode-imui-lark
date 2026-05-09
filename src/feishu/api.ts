import crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Asset, FeishuApi, RenderOut } from "../contracts.js"
import { createFeishuAuth } from "./auth.js"

function dump(tag: string, target: string, out: RenderOut) {
  console.log(
    JSON.stringify({
      tag,
      target,
      out,
    }),
  )
}

type CardData = {
  type?: "approval" | "question"
  title?: string
  text?: string
  step?: string
  template?: string
  req?: string
  tool?: string
  detail?: string
  options?: string[]
  custom?: boolean
}

type CardPlainText = {
  tag: "plain_text"
  content: string
}

type ApprovalChoice = "once" | "always" | "reject"

type CardCallbackValue = {
  req: string
  kind: "approval" | "question"
  req_type: "permission" | "question"
  choice?: ApprovalChoice
  choices_field?: string
}

type CardBehavior = {
  type: "callback"
  value: CardCallbackValue
}

type CardMarkdownElement = {
  tag: "markdown"
  content: string
}

type CardButtonElement = {
  tag: "button"
  name: string
  text: CardPlainText
  type?: "default" | "primary" | "primary_filled" | "danger" | "danger_filled"
  form_action_type?: "submit" | "reset"
  behaviors: CardBehavior[]
}

type CardSelectOption = {
  text: CardPlainText
  value: string
}

type CardMultiSelectElement = {
  tag: "multi_select_static"
  name: string
  required: boolean
  width: "fill"
  placeholder: CardPlainText
  selected_values: string[]
  options: CardSelectOption[]
}

type CardFormElement = {
  tag: "form"
  name: string
  elements: Array<CardMultiSelectElement | CardButtonElement>
}

type CardElement = CardMarkdownElement | CardButtonElement | CardFormElement

type CardPayload = {
  schema: "2.0"
  config: {
    wide_screen_mode: boolean
    update_multi?: boolean
  }
  header?: {
    template: string
    title: {
      tag: "plain_text"
      content: string
    }
  }
  body: {
    elements: CardElement[]
  }
}

function imageLabel(alt: string, url: string) {
  const name = alt.trim() ? `图片（${alt.trim()}）` : "图片"
  return `${name}：${url}`
}

function plain(content: string): CardPlainText {
  return {
    tag: "plain_text",
    content,
  }
}

export function sanitizeMarkdown(text: string) {
  return text
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt: string, url: string) => imageLabel(alt, url))
    .replace(/<img\b[^>]*src=["'](https?:\/\/[^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, url: string, alt: string) =>
      imageLabel(alt, url),
    )
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["'](https?:\/\/[^"']+)["'][^>]*>/gi, (_, alt: string, url: string) =>
      imageLabel(alt, url),
    )
    .replace(/<img\b[^>]*src=["'](https?:\/\/[^"']+)["'][^>]*>/gi, (_, url: string) => imageLabel("", url))
}

function markdown(text: string): CardElement {
  return {
    tag: "markdown",
    content: sanitizeMarkdown(text),
  }
}

function button(input: {
  text: string
  name: string
  value: CardCallbackValue
  type?: CardButtonElement["type"]
  form_action_type?: CardButtonElement["form_action_type"]
}): CardButtonElement {
  return {
    tag: "button",
    name: input.name,
    text: plain(input.text),
    type: input.type,
    form_action_type: input.form_action_type,
    behaviors: [
      {
        type: "callback",
        value: input.value,
      },
    ],
  }
}

function selectOption(label: string): CardSelectOption {
  return {
    text: plain(label),
    value: label,
  }
}

function approvalValue(req: string | undefined, choice: ApprovalChoice): CardCallbackValue {
  return {
    req: req ?? "",
    kind: "approval",
    req_type: "permission",
    choice,
  }
}

const question_field = "choices"

function questionValue(req: string | undefined): CardCallbackValue {
  return {
    req: req ?? "",
    kind: "question",
    req_type: "question",
    choices_field: question_field,
  }
}

function questionForm(body: CardData): CardFormElement {
  return {
    tag: "form",
    name: "question_form",
    elements: [
      {
        tag: "multi_select_static",
        name: question_field,
        required: true,
        width: "fill",
        placeholder: plain("请选择一个或多个选项"),
        selected_values: [],
        options: (body.options ?? []).map(selectOption),
      },
      button({
        text: "提交选择",
        name: "submit_question",
        type: "primary_filled",
        form_action_type: "submit",
        value: questionValue(body.req),
      }),
    ],
  }
}

function numbered(list: string[]) {
  return list.map((item, index) => `${index + 1}. ${item}`).join("\n")
}

function payload(input: Omit<CardPayload, "schema" | "body"> & { elements: CardElement[] }): CardPayload {
  return {
    schema: "2.0",
    config: input.config,
    header: input.header,
    body: {
      elements: input.elements,
    },
  }
}

function approval(body: CardData) {
  const list = ["允许一次", "始终允许", "拒绝"]
  return payload({
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: "orange",
      title: {
        tag: "plain_text",
        content: body.title ?? "权限审批",
      },
    },
    elements: [
      markdown(`**工具:** ${body.tool ?? "tool"}`),
      ...(body.detail ? [markdown(body.detail)] : []),
      markdown(`请直接回复序号继续；如需更正本次操作，也可以直接发送文本。\n${numbered(list)}`),
      button({
        text: list[0],
        name: "approval_once",
        type: "primary_filled",
        value: approvalValue(body.req, "once"),
      }),
      button({
        text: list[1],
        name: "approval_always",
        type: "default",
        value: approvalValue(body.req, "always"),
      }),
      button({
        text: list[2],
        name: "approval_reject",
        type: "danger_filled",
        value: approvalValue(body.req, "reject"),
      }),
    ],
  })
}

function status(body: CardData) {
  return payload({
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: body.template ?? "blue",
      title: {
        tag: "plain_text",
        content: body.title ?? "OpenCode",
      },
    },
    elements: [
      ...(body.step ? [markdown(`**${body.step}**`)] : []),
      markdown(body.text ?? ""),
    ],
  })
}

function question(body: CardData) {
  const list = body.options ?? []
  const hint =
    list.length === 0
      ? "请直接发送文字继续。"
      : body.custom
        ? `请优先回复序号继续；如需多选，可回复 1,2；如需自定义回答，也可以直接发送文字。\n${numbered(list)}`
        : `请直接回复序号继续；如需多选，可回复 1,2。\n${numbered(list)}`

  return payload({
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: body.title ?? "请补充信息",
      },
    },
    elements: [
      markdown(hint),
      ...(list.length > 0 ? [questionForm(body)] : []),
    ],
  })
}

export function buildCard(body: unknown) {
  if (!body || typeof body !== "object") return {}
  const val = body as CardData
  if (val.type === "approval") return approval(val)
  if (val.type === "question" || Array.isArray(val.options) || !!val.custom) return question(val)
  if (typeof val.text === "string") return status(val)
  return val
}

function data(out: RenderOut) {
  if (out.kind === "text") {
    const body = out.body as { text?: string } | null
    return JSON.stringify({
      text: body?.text ?? "",
    })
  }

  return JSON.stringify(buildCard(out.body))
}

type Data = {
  code?: number
  msg?: string
  data?: unknown
}

function kind(body: Record<string, unknown>) {
  if (body.msg_type === "interactive") return "card"
  const val = body.content
  if (typeof val !== "string") return "text"
  try {
    const raw = JSON.parse(val) as Record<string, unknown>
    return raw && typeof raw === "object" && "config" in raw ? "card" : "text"
  } catch {
    return "text"
  }
}

function err(raw: Data) {
  return raw.msg ? `feishu api failed: ${raw.msg}` : "feishu api failed"
}

function obj(val: unknown) {
  if (!val || typeof val !== "object") return
  return val as Record<string, unknown>
}

function str(val: unknown, key: string) {
  const item = obj(val)?.[key]
  if (typeof item !== "string" || !item) return
  return item
}

function list(val: unknown) {
  return Array.isArray(val) ? val : []
}

type Input = {
  app_id?: string
  app_secret?: string
  cache?: string
}

function ext(mime?: string, name?: string, kind?: "file" | "image") {
  if (name) {
    const hit = /\.[a-zA-Z0-9._-]+$/.exec(name)
    if (hit) return hit[0]
  }
  if (!mime) return kind === "image" ? ".png" : ".bin"
  if (mime === "image/png") return ".png"
  if (mime === "image/jpeg") return ".jpg"
  if (mime === "image/webp") return ".webp"
  if (mime === "application/pdf") return ".pdf"
  if (mime === "text/plain") return ".txt"
  const tail = mime.split("/").at(-1)
  if (!tail) return ".bin"
  return "." + tail.replace(/[^a-zA-Z0-9._-]/g, "")
}

function safe(name?: string) {
  if (!name) return ""
  return name.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function stem(name?: string) {
  if (!name) return ""
  const safe_name = safe(name)
  const ext = /\.[a-zA-Z0-9._-]+$/.exec(safe_name)
  if (!ext) return safe_name
  return safe_name.slice(0, -ext[0].length)
}

function dir(root?: string) {
  const val = root ? path.resolve(root) : path.resolve(process.cwd(), ".data/asset")
  mkdirSync(val, { recursive: true })
  return val
}

function pick(headers: Headers, key: string) {
  const val = headers.get(key)
  if (!val) return
  return val
}

function filename(headers: Headers, name?: string) {
  const item = pick(headers, "content-disposition")
  if (!item) return name
  const star = /filename\*=UTF-8''([^;]+)/i.exec(item)
  if (star?.[1]) return decodeURIComponent(star[1])
  const plain = /filename="?([^";]+)"?/i.exec(item)
  if (plain?.[1]) return plain[1]
  return name
}

export function createFeishuApi(input?: Input): FeishuApi {
  const auth = createFeishuAuth({
    app_id: input?.app_id,
    app_secret: input?.app_secret,
  })
  let names: string[] = []
  let load: Promise<void> | undefined

  const save = (val: string[]) => {
    names = Array.from(new Set([...names, ...val.filter(Boolean)]))
  }

  const learn = (val: unknown) => {
    const app = obj(obj(val)?.app)
    save([
      str(app, "app_name") ?? "",
      ...list(app?.i18n).map((item) => str(item, "name") ?? ""),
    ])
  }

  const req = async (method: string, path: string, body?: Record<string, unknown>, query?: URLSearchParams) => {
    if (!auth.enabled()) {
      const target = query?.get("receive_id_type") === "chat_id" ? String(body?.receive_id ?? "") : path
      dump(method, target, {
        kind: kind(body ?? {}),
        body: body?.content ? JSON.parse(String(body.content)) : body,
      })
      return {
        code: 0,
        data: {
          message_id: "fsm_" + crypto.randomUUID(),
        },
      } satisfies Data
    }

    const url = new URL("https://open.feishu.cn/open-apis" + path)
    if (query) {
      for (const [k, v] of query.entries()) url.searchParams.set(k, v)
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await auth.tenant()}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const raw = await res.text()
      throw new Error(raw ? `feishu api failed: ${res.status} ${res.statusText} - ${raw}` : `feishu api failed: ${res.status} ${res.statusText}`)
    }

    const raw = (await res.json()) as Data
    if (raw.code !== 0) {
      throw new Error(err(raw))
    }
    return raw
  }

  const fetchbin = async (message_id: string, asset: Asset) => {
    const root = dir(input?.cache)
    const file = path.join(root, [Date.now(), crypto.randomUUID(), stem(asset.name) || asset.key].join("-"))

    if (!auth.enabled()) {
      const mock = asset.kind === "image"
        ? Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
        : Buffer.from(`mock asset ${asset.name ?? asset.key}`)
      const target = file + ext(asset.mime, asset.name, asset.kind)
      await writeFile(target, mock)
      return {
        ...asset,
        path: target,
        url: pathToFileURL(target).href,
      }
    }

    const url = new URL(`https://open.feishu.cn/open-apis/im/v1/messages/${message_id}/resources/${asset.key}`)
    url.searchParams.set("type", asset.kind)
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await auth.tenant()}`,
      },
    })

    if (!res.ok) {
      const raw = await res.text()
      throw new Error(raw ? `feishu asset failed: ${res.status} ${res.statusText} - ${raw}` : `feishu asset failed: ${res.status} ${res.statusText}`)
    }

    const mime = pick(res.headers, "content-type") ?? asset.mime ?? (asset.kind === "image" ? "image/png" : "application/octet-stream")
    const name = filename(res.headers, asset.name) ?? `${asset.kind}-${asset.key}${ext(mime, asset.name, asset.kind)}`
    const target = file + ext(mime, name, asset.kind)
    await writeFile(target, new Uint8Array(await res.arrayBuffer()))

    return {
      ...asset,
      name,
      mime,
      path: target,
      url: pathToFileURL(target).href,
    }
  }

  return {
    async send(input) {
      const raw = await req(
        "POST",
        "/im/v1/messages",
        {
          receive_id: input.chat_id,
          msg_type: input.out.kind === "card" ? "interactive" : "text",
          content: data(input.out),
        },
        new URLSearchParams({
          receive_id_type: "chat_id",
        }),
      )
      return {
        id: str(raw.data, "message_id") ?? "fsm_" + crypto.randomUUID(),
      }
    },

    async reply(input) {
      const raw = await req("POST", `/im/v1/messages/${input.msg_id}/reply`, {
        msg_type: input.out.kind === "card" ? "interactive" : "text",
        content: data(input.out),
      })
      return {
        id: str(raw.data, "message_id") ?? "fsm_" + crypto.randomUUID(),
      }
    },

    async patch(input) {
      await req("PATCH", `/im/v1/messages/${input.msg_id}`, {
        content: data(input.out),
      })
    },

    async fetch(input) {
      return fetchbin(input.message_id, input.asset)
    },

    async sync() {
      if (!auth.enabled() || !input?.app_id || names.length > 0) return
      if (!load) {
        load = req("GET", `/application/v6/applications/${input.app_id}`, undefined, new URLSearchParams({ lang: "zh_cn" }))
          .then((raw) => {
            learn(raw.data)
          })
          .catch((err) => {
            console.warn("[feishu.api]", err instanceof Error ? err.message : String(err))
          })
          .finally(() => {
            load = undefined
          })
      }
      await load
    },

    names() {
      return names
    },
  }
}
