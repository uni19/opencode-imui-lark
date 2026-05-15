import crypto from "node:crypto"
import type { ChatType, ImSession, OpencodeSvc, SessionModelPref, SessionSvc, Store } from "../contracts.js"

type Input = {
  store: Store
  opencode: OpencodeSvc
  directory?: string
  workspace?: string
  model?: ImSession["model"]
}

const now = () => Date.now()
const pending_session_prefix = "pending_new:"

function has<K extends string>(input: object, key: K): input is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(input, key)
}

export function pending_session_id() {
  return pending_session_prefix + crypto.randomUUID()
}

export function is_pending_session(row?: Pick<ImSession, "state"> | null) {
  return row?.state === "pending_new"
}

async function pref(input: Input, val: { tenant_id: string; chat_id: string; user_id: string }) {
  const chat = await input.store.get_pref({
    scope: "chat",
    tenant_id: val.tenant_id,
    chat_id: val.chat_id,
  })
  if (chat?.directory || chat?.workspace_id) return chat
  const user = await input.store.get_pref({
    scope: "user",
    tenant_id: val.tenant_id,
    user_id: val.user_id,
  })
  if (user?.directory || user?.workspace_id) return user
  return {
    scope: "user" as const,
    tenant_id: val.tenant_id,
    user_id: val.user_id,
    directory: input.directory,
    workspace_id: input.workspace,
  }
}

function create(
  tenant_id: string,
  chat_id: string,
  chat_type: ChatType | undefined,
  thread_id: string | undefined,
  root_message_id: string | undefined,
  user_id: string,
  session_id: string,
  directory?: string,
  workspace_id?: string,
  model?: ImSession["model"],
  state: ImSession["state"] = "active",
): ImSession {
  const time = now()
  return {
    id: "ims_" + crypto.randomUUID(),
    platform: "feishu",
    tenant_id,
    chat_id,
    chat_type,
    thread_id,
    root_message_id,
    user_id,
    session_id,
    directory,
    workspace_id,
    model,
    state,
    created_at: time,
    updated_at: time,
  }
}

async function materialize_pending(input: Input, row: ImSession): Promise<ImSession> {
  const result = await input.opencode.ensure({
    directory: row.directory,
    workspace: row.workspace_id,
    model: row.model,
  })
  const next = {
    ...row,
    session_id: result.id,
    state: "active" as const,
    updated_at: now(),
  }
  await input.store.save_session(next)
  await input.store.move_session_model_pref(row.session_id, next.session_id)
  return next
}

function pref_model(pref: SessionModelPref | null, fallback: ImSession["model"]) {
  if (!pref) return fallback
  return pref.mode === "default" ? fallback : pref.model
}

async function rehydrate_active_session(input: Input, row: ImSession): Promise<ImSession> {
  const pref = await input.store.get_session_model_pref(row.session_id)
  if (!pref) return row
  const next = {
    ...row,
    model: pref_model(pref, input.model),
  }
  if (next.model === row.model) return row
  await input.store.save_session(next)
  return next
}

async function current_session(
  input: Input,
  val: { tenant_id: string; chat_id: string; thread_id?: string },
): Promise<ImSession | null> {
  const existing = await input.store.get_session({
    tenant_id: val.tenant_id,
    chat_id: val.chat_id,
    thread_id: val.thread_id,
  })
  if (!existing || is_pending_session(existing)) return existing
  return rehydrate_active_session(input, existing)
}

export function createSessionSvc(input: Input): SessionSvc {
  return {
    async current(val) {
      return current_session(input, val)
    },

    async resolve(val) {
      const existing = await current_session(input, val)
      if (existing) {
        if (is_pending_session(existing)) return materialize_pending(input, existing)
        return existing
      }
      const bind = await pref(input, val)
      const result = await input.opencode.ensure({
        directory: bind.directory,
        workspace: bind.workspace_id,
        model: input.model,
      })
      const next = create(
        val.tenant_id,
        val.chat_id,
        val.chat_type,
        val.thread_id,
        val.root_message_id,
        val.user_id,
        result.id,
        bind.directory,
        bind.workspace_id,
        input.model,
      )
      await input.store.save_session(next)
      return next
    },

    async reset(val) {
      const bind = await pref(input, val)
      const next = create(
        val.tenant_id,
        val.chat_id,
        val.chat_type,
        val.thread_id,
        val.root_message_id,
        val.user_id,
        pending_session_id(),
        bind.directory,
        bind.workspace_id,
        input.model,
        "pending_new",
      )
      await input.store.save_session(next)
      return next
    },

    async switch(val) {
      const current = await input.store.get_session({
        tenant_id: val.tenant_id,
        chat_id: val.chat_id,
        thread_id: val.thread_id,
      })
      const known = await input.store.get_session_by_opencode(val.session.id)
      const pref = await input.store.get_session_model_pref(val.session.id)
      const model = pref
        ? pref_model(pref, input.model)
        : known?.model ?? val.session.model ?? input.model
      const next = current
        ? {
            ...current,
            chat_type: val.chat_type,
            root_message_id: val.root_message_id,
            user_id: val.user_id,
            session_id: val.session.id,
            directory: val.session.directory,
            workspace_id: val.session.workspace_id,
            model,
            state: "active" as const,
            updated_at: now(),
          }
        : create(
            val.tenant_id,
            val.chat_id,
            val.chat_type,
            val.thread_id,
            val.root_message_id,
            val.user_id,
            val.session.id,
            val.session.directory,
            val.session.workspace_id,
            model,
          )
      await input.store.save_session(next)
      return next
    },

    async bind(val) {
      const items = await input.store.get_session_by_opencode(val.session_id)
      if (!items) return null
      const directory = val.directory ?? items.directory
      const workspace_id = has(val, "workspace_id") ? val.workspace_id : items.workspace_id
      const reset = directory !== items.directory || workspace_id !== items.workspace_id
      const session = !is_pending_session(items) && reset
        ? await input.opencode.ensure({
            directory,
            workspace: workspace_id,
            model: items.model,
          })
        : { id: items.session_id }
      const next = {
        ...items,
        session_id: session.id,
        directory,
        workspace_id,
        updated_at: now(),
      }
      await input.store.save_session(next)
      return next
    },

    async model(val) {
      const item = await input.store.get_session_by_opencode(val.session_id)
      if (!item) return null
      const mode = val.mode ?? (val.model ? "explicit" : "default")
      const explicit = val.model
      if (mode === "explicit" && !explicit) return null
      let pref: SessionModelPref
      let next_model: ImSession["model"]
      if (mode === "default") {
        pref = { mode }
        next_model = input.model
      } else {
        const model = val.model
        if (!model) return null
        pref = {
          mode,
          model,
        }
        next_model = model
      }
      await input.store.save_session_model_pref(
        val.session_id,
        pref,
      )
      const next = {
        ...item,
        model: next_model,
        updated_at: now(),
      }
      await input.store.save_session(next)
      return next
    },
  }
}
