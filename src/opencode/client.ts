import path from "node:path"
import type {
  AppCfg,
  OpencodeAgent,
  OpencodeCommand,
  OpencodeMcp,
  OpencodeModel,
  OpencodeProvider,
  OpencodeResult,
  OpencodeSession,
  OpencodeSkill,
  OpencodeStatus,
  OpencodeSvc,
  PromptPart,
} from "../contracts.js"

type Json = Record<string, unknown>

type Message = {
  info?: {
    role?: string
    summary?: boolean
    time?: {
      completed?: number
    }
    error?: unknown
  }
  parts?: unknown[]
}

function auth(cfg: AppCfg) {
  if (!cfg.opencode.password) return
  const token = Buffer.from([cfg.opencode.username, cfg.opencode.password].join(":")).toString("base64")
  return `Basic ${token}`
}

function dir(val?: string) {
  if (!val) return
  return path.resolve(val)
}

function qs(input: { directory?: string; workspace?: string }) {
  const url = new URLSearchParams()
  const directory = dir(input.directory)
  if (directory) url.set("directory", directory)
  if (input.workspace) url.set("workspace", input.workspace)
  const val = url.toString()
  if (!val) return ""
  return "?" + val
}

function text(parts: unknown) {
  if (!Array.isArray(parts)) return
  const list = parts
    .filter(
      (
        item,
      ): item is {
        type: string
        text?: string
        time?: { end?: number }
        synthetic?: boolean
        ignored?: boolean
      } => !!item && typeof item === "object",
    )
    .filter((item) => item.type === "text" && !!item.time?.end && !!item.text && !item.synthetic && !item.ignored)
    .map((item) => item.text?.trim())
    .filter((item): item is string => !!item)
  if (list.length === 0) return
  return list.join("\n\n")
}

function rawtext(parts: unknown) {
  if (!Array.isArray(parts)) return
  const list = parts
    .filter(
      (
        item,
      ): item is {
        type: string
        text?: string
        time?: { end?: number }
      } => !!item && typeof item === "object",
    )
    .filter((item) => item.type === "text" && !!item.time?.end && !!item.text)
    .map((item) => item.text?.trim())
    .filter((item): item is string => !!item)
  if (list.length === 0) return
  return list.join("\n\n")
}

function output(msg: unknown) {
  const item = msg as Message
  return text(item.parts)
}

async function req(cfg: AppCfg, method: string, path: string, body?: Json) {
  const headers = new Headers({
    "content-type": "application/json",
  })
  const token = auth(cfg)
  if (token) headers.set("Authorization", token)

  const res = await fetch(cfg.opencode.base_url + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const raw = res.status === 204 ? "" : await res.text()
  if (!res.ok) {
    throw new Error(raw ? `opencode request failed: ${res.status} ${res.statusText} - ${raw}` : `opencode request failed: ${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return
  if (!raw) return
  return JSON.parse(raw)
}

function assistant(item: unknown): item is { info?: { role?: string }; parts?: unknown[] } {
  if (!item || typeof item !== "object") return false
  if (!("info" in item)) return false
  const info = item.info
  if (!info || typeof info !== "object") return false
  if (!("role" in info)) return false
  return info.role === "assistant"
}

function ended(item: Message) {
  return !!item.info?.time?.completed
}

function failed(item: Message) {
  return !!item.info?.error
}

function summary(item: Message) {
  return item.info?.summary === true
}

function pick(list: Message[]) {
  for (const msg of list) {
    const val = output(msg)
    if (val) return val
  }
}

function inspect(data: unknown): OpencodeResult {
  if (!Array.isArray(data)) return { state: "empty" }
  const all = [...data].reverse().filter(assistant)
  const list = all.filter((item) => !summary(item))
  const text =
    pick(list.filter((item) => ended(item) && !failed(item))) ??
    pick(list.filter(ended)) ??
    pick(list.filter((item) => !failed(item))) ??
    pick(list)
  if (text) return { state: "ok", text }
  if (all.some((item) => !!rawtext(item.parts))) return { state: "filtered" }
  return { state: "empty" }
}

export function createOpencodeSvc(cfg: AppCfg): OpencodeSvc {
  const base = (directory?: string, workspace?: string) =>
    qs({
      directory: directory ?? cfg.opencode.directory,
      workspace: workspace ?? cfg.opencode.workspace,
    })

  const model = (val?: OpencodeModel) => val ?? cfg.opencode.model

  return {
    async ensure(input) {
      if (input.session_id) return { id: input.session_id }
      const data = await req(cfg, "POST", "/session" + base(input.directory, input.workspace), {})
      const id = (data as { id?: string }).id
      if (!id) throw new Error("opencode session.create returned no id")
      return { id }
    },

    async session(id) {
      const data = await req(cfg, "GET", `/session/${id}`)
      if (!data || typeof data !== "object") return null
      const item = data as Record<string, unknown>
      const session = {
        id: String(item.id ?? ""),
        title: String(item.title ?? item.id ?? ""),
        directory: String(item.directory ?? ""),
        workspace_id: typeof item.workspaceID === "string" ? item.workspaceID : undefined,
        parent_id: typeof item.parentID === "string" ? item.parentID : undefined,
        created_at:
          item.time && typeof item.time === "object" && "created" in item.time ? Number(item.time.created ?? 0) : 0,
        updated_at:
          item.time && typeof item.time === "object" && "updated" in item.time ? Number(item.time.updated ?? 0) : 0,
      } satisfies OpencodeSession
      if (!session.id) return null
      return session
    },

    async sessions(input) {
      const query = new URLSearchParams()
      const directory = dir(input.directory ?? cfg.opencode.directory)
      if (directory) query.set("directory", directory)
      if (input.limit) query.set("limit", String(input.limit))
      if (input.roots) query.set("roots", "true")
      const suffix = query.toString() ? "?" + query.toString() : ""
      const data = await req(cfg, "GET", "/session" + suffix)
      if (!Array.isArray(data)) return []
      return data
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          id: String(item.id ?? ""),
          title: String(item.title ?? item.id ?? ""),
          directory: String(item.directory ?? ""),
          workspace_id: typeof item.workspaceID === "string" ? item.workspaceID : undefined,
          parent_id: typeof item.parentID === "string" ? item.parentID : undefined,
          created_at:
            item.time && typeof item.time === "object" && "created" in item.time ? Number(item.time.created ?? 0) : 0,
          updated_at:
            item.time && typeof item.time === "object" && "updated" in item.time ? Number(item.time.updated ?? 0) : 0,
        }))
        .filter((item) => !!item.id)
    },

    async status(input) {
      const data = await req(cfg, "GET", "/session/status" + base(input.directory, input.workspace))
      if (!data || typeof data !== "object") return {}
      return Object.fromEntries(
        Object.entries(data)
          .filter(([, val]) => !!val && typeof val === "object")
          .map(([key, val]) => [key, val as OpencodeStatus]),
      )
    },

    async commands() {
      const data = await req(cfg, "GET", "/command")
      if (!Array.isArray(data)) return []
      return data
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          name: String(item.name ?? ""),
          description: typeof item.description === "string" ? item.description : undefined,
          source:
            item.source === "command" || item.source === "mcp" || item.source === "skill"
              ? item.source
              : undefined,
          hints: Array.isArray(item.hints) ? item.hints.filter((val): val is string => typeof val === "string") : [],
        } satisfies OpencodeCommand))
        .filter((item) => !!item.name)
    },

    async skills() {
      const data = await req(cfg, "GET", "/skill")
      if (!Array.isArray(data)) return []
      return data
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          name: String(item.name ?? ""),
          description: String(item.description ?? ""),
          location: String(item.location ?? ""),
        } satisfies OpencodeSkill))
        .filter((item) => !!item.name)
    },

    async agents() {
      const data = await req(cfg, "GET", "/agent")
      if (!Array.isArray(data)) return []
      return data
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          name: String(item.name ?? ""),
          description: typeof item.description === "string" ? item.description : undefined,
          mode: item.mode === "subagent" || item.mode === "all" ? item.mode : "primary",
          hidden: typeof item.hidden === "boolean" ? item.hidden : undefined,
          model:
            item.model && typeof item.model === "object"
              ? {
                  provider_id: String((item.model as Record<string, unknown>).providerID ?? ""),
                  model_id: String((item.model as Record<string, unknown>).modelID ?? ""),
                }
              : undefined,
        } satisfies OpencodeAgent))
        .filter((item) => !!item.name && !item.hidden)
    },

    async providers() {
      const data = await req(cfg, "GET", "/provider")
      if (!data || typeof data !== "object") return []
      const root = data as Record<string, unknown>
      const all = Array.isArray(root.all) ? root.all : []
      const connected = Array.isArray(root.connected)
        ? root.connected.filter((item): item is string => typeof item === "string")
        : []
      const defaults = root.default && typeof root.default === "object" ? (root.default as Record<string, unknown>) : {}
      const list = all
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          id: String(item.id ?? ""),
          name: String(item.name ?? item.id ?? ""),
          connected: connected.includes(String(item.id ?? "")),
          default_model: typeof defaults[String(item.id ?? "")] === "string" ? String(defaults[String(item.id ?? "")]) : undefined,
          models:
            item.models && typeof item.models === "object"
              ? Object.entries(item.models as Record<string, unknown>)
                  .filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object")
                  .map(([id, info]) => ({
                    id,
                    name: typeof info.name === "string" ? info.name : id,
                  }))
              : [],
        } satisfies OpencodeProvider))
        .filter((item) => !!item.id)
      const active = list.filter((item) => item.connected)
      return active.length > 0 ? active : list
    },

    async mcps() {
      const data = await req(cfg, "GET", "/mcp")
      if (!data || typeof data !== "object") return []
      return Object.entries(data)
        .filter(([, item]) => !!item && typeof item === "object")
        .map(([name, item]) => ({
          name,
          status:
            (item as Record<string, unknown>).status === "connected" ||
            (item as Record<string, unknown>).status === "disabled" ||
            (item as Record<string, unknown>).status === "failed" ||
            (item as Record<string, unknown>).status === "needs_auth" ||
            (item as Record<string, unknown>).status === "needs_client_registration"
              ? ((item as Record<string, unknown>).status as OpencodeMcp["status"])
              : "failed",
          error:
            typeof (item as Record<string, unknown>).error === "string"
              ? ((item as Record<string, unknown>).error as string)
              : undefined,
        } satisfies OpencodeMcp))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async prompt(input) {
      const parts = input.parts ?? (input.text ? [{ type: "text", text: input.text } satisfies PromptPart] : [])
      await req(
        cfg,
        "POST",
        `/session/${input.session_id}/prompt_async` + base(input.directory, input.workspace),
        {
          agent: input.agent ?? cfg.opencode.agent,
          model: model(input.model),
          parts,
        },
      )
    },

    async abort(input) {
      await req(cfg, "POST", `/session/${input.session_id}/abort` + base(input.directory, input.workspace), {})
    },

    async allow(input) {
      await req(cfg, "POST", `/permission/${input.req}/reply` + base(input.directory, input.workspace), {
        reply: input.reply,
        ...(input.message ? { message: input.message } : {}),
      })
    },

    async answer(input) {
      await req(cfg, "POST", `/question/${input.req}/reply` + base(input.directory, input.workspace), {
        answers: input.answers,
      })
    },

    async reject(input) {
      await req(cfg, "POST", `/question/${input.req}/reject` + base(input.directory, input.workspace), {})
    },

    async command(input) {
      const data = await req(cfg, "POST", `/session/${input.session_id}/command` + base(input.directory, input.workspace), {
        command: input.command,
        arguments: input.arguments,
      })
      return output(data)
    },

    async last(input) {
      const data = await req(
        cfg,
        "GET",
        `/session/${input.session_id}/message` + base(input.directory, input.workspace),
      )
      return inspect(data).text
    },

    async result(input) {
      const data = await req(
        cfg,
        "GET",
        `/session/${input.session_id}/message` + base(input.directory, input.workspace),
      )
      return inspect(data)
    },
  }
}
