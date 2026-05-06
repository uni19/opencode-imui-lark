import crypto from "node:crypto"
import type { ChatType, ImSession, OpencodeSvc, SessionSvc, Store } from "../contracts.js"

type Input = {
  store: Store
  opencode: OpencodeSvc
  directory?: string
  workspace?: string
  model?: ImSession["model"]
}

const now = () => Date.now()

function has<K extends string>(input: object, key: K): input is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(input, key)
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
    state: "active",
    created_at: time,
    updated_at: time,
  }
}

export function createSessionSvc(input: Input): SessionSvc {
  return {
    async resolve(val) {
      const existing = await input.store.get_session({
        tenant_id: val.tenant_id,
        chat_id: val.chat_id,
        thread_id: val.thread_id,
      })
      if (existing) return existing
      const bind = await pref(input, val)
      const result = await input.opencode.ensure({
        directory: bind.directory,
        workspace: bind.workspace_id,
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
      const result = await input.opencode.ensure({
        directory: bind.directory,
        workspace: bind.workspace_id,
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

    async switch(val) {
      const current = await input.store.get_session({
        tenant_id: val.tenant_id,
        chat_id: val.chat_id,
        thread_id: val.thread_id,
      })
      const known = await input.store.get_session_by_opencode(val.session.id)
      const next = current
        ? {
            ...current,
            chat_type: val.chat_type,
            root_message_id: val.root_message_id,
            user_id: val.user_id,
            session_id: val.session.id,
            directory: val.session.directory,
            workspace_id: val.session.workspace_id,
            model: known?.model ?? current.model ?? input.model,
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
            known?.model ?? input.model,
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
      const session = reset
        ? await input.opencode.ensure({
            directory,
            workspace: workspace_id,
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
      const next = {
        ...item,
        model: val.model,
        updated_at: now(),
      }
      await input.store.save_session(next)
      return next
    },
  }
}
