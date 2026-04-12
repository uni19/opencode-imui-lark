export type ChatType = "group" | "p2p" | "group_chat" | "p2p_chat" | string

export type Asset = {
  kind: "image" | "file"
  key: string
  name?: string
  mime?: string
  path?: string
  url?: string
}

export type PromptPart =
  | {
      type: "text"
      text: string
    }
  | {
      type: "file"
      url: string
      mime: string
      filename: string
    }

export type Inbound = {
  id: string
  platform: "feishu"
  kind: "message"
  event_id: string
  tenant_id: string
  chat_id: string
  chat_type?: ChatType
  thread_id?: string
  user_id: string
  raw: unknown
  created_at: number
}

export type InboundMessage = Inbound & {
  kind: "message"
  text: string
  message_id: string
  root_message_id?: string
  parent_message_id?: string
  message_type?: string
  assets: Asset[]
  mentions: string[]
  mention_names?: string[]
}

export type InboundEvent = InboundMessage

export type ImSession = {
  id: string
  platform: "feishu"
  tenant_id: string
  chat_id: string
  chat_type?: ChatType
  thread_id?: string
  root_message_id?: string
  user_id?: string
  session_id: string
  directory?: string
  workspace_id?: string
  model?: OpencodeModel
  state: "active" | "archived" | "error"
  created_at: number
  updated_at: number
}

export type Task = {
  id: string
  im_session_id: string
  session_id: string
  inbound_id: string
  directory?: string
  workspace_id?: string
  outbound_id?: string
  note?: string
  status:
    | "queued"
    | "acked"
    | "running"
    | "waiting_permission"
    | "waiting_question"
    | "waiting_attachment"
    | "completed"
    | "failed"
    | "aborted"
  req_type?: "permission" | "question" | "attachment"
  req?: string
  err?: string
  created_at: number
  updated_at: number
}

export type Pending = {
  session_id: string
  inbound_id: string
  assets: Asset[]
  created_at: number
  updated_at: number
}

export type Outbound = {
  task_id: string
  msg_id: string
  kind: "text" | "card"
  payload: unknown
  created_at: number
  updated_at: number
}

export type Attachment = {
  message_id: string
  key: string
  asset: Asset
  created_at: number
  updated_at: number
}

export type ConnState = {
  name: "message" | "card" | "opencode"
  status: "connecting" | "ready" | "reconnecting" | "stopped" | "error"
  updated_at: number
  err?: string
  attempt?: number
  wait_ms?: number
}

export type Job = {
  id: string
}

export type QueueJob = Job & {
  status: "queued" | "running" | "done" | "failed"
  err?: string
  created_at: number
  updated_at: number
}

export type RenderOut = {
  kind: "text" | "card"
  body: unknown
}

export type OpencodeModel = {
  providerID: string
  modelID: string
}

export type OpencodeEvent = {
  type: string
  properties: Record<string, unknown>
}

export type OpencodeSession = {
  id: string
  title: string
  directory: string
  workspace_id?: string
  parent_id?: string
  created_at: number
  updated_at: number
}

export type OpencodeStatus =
  | {
      type: "idle"
    }
  | {
      type: "busy"
    }
  | {
      type: "retry"
      attempt: number
      message: string
      next: number
    }

export type OpencodeCommand = {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
  hints: string[]
}

export type OpencodeSkill = {
  name: string
  description: string
  location: string
}

export type OpencodeAgent = {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden?: boolean
  model?: {
    provider_id: string
    model_id: string
  }
}

export type OpencodeProvider = {
  id: string
  name: string
  connected: boolean
  default_model?: string
  models: Array<{
    id: string
    name: string
  }>
}

export type OpencodeMcp = {
  name: string
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"
  error?: string
}

export type OpencodeResult = {
  state: "ok" | "filtered" | "empty"
  text?: string
}

export type FeishuMode = "stdin" | "long_conn" | "off"

export type RepoPref = {
  scope: "chat" | "user"
  tenant_id: string
  chat_id?: string
  user_id?: string
  directory?: string
  workspace_id?: string
}

export type AppCfg = {
  log: {
    level: "debug" | "info" | "warn" | "error"
  }
  storage: {
    path: string
  }
  feishu: {
    mode: FeishuMode
    app_id?: string
    app_secret?: string
    bot_id?: string
  }
  opencode: {
    base_url: string
    username: string
    password?: string
    directory?: string
    workspace?: string
    agent?: string
    model?: OpencodeModel
  }
}

export type FeishuConn = {
  start(): Promise<void>
  stop(): Promise<void>
}

export type FeishuApi = {
  send(input: { chat_id: string; out: RenderOut }): Promise<{ id: string }>
  reply(input: { msg_id: string; out: RenderOut }): Promise<{ id: string }>
  patch(input: { msg_id: string; out: RenderOut }): Promise<void>
  fetch(input: { message_id: string; asset: Asset }): Promise<Asset>
  sync(): Promise<void>
  names(): string[]
}

export type Queue = {
  push(input: Job): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export type SessionSvc = {
  resolve(input: {
    tenant_id: string
    chat_id: string
    chat_type?: ChatType
    thread_id?: string
    root_message_id?: string
    user_id: string
  }): Promise<ImSession>
  reset(input: {
    tenant_id: string
    chat_id: string
    chat_type?: ChatType
    thread_id?: string
    root_message_id?: string
    user_id: string
  }): Promise<ImSession>
  switch(input: {
    tenant_id: string
    chat_id: string
    chat_type?: ChatType
    thread_id?: string
    root_message_id?: string
    user_id: string
    session: OpencodeSession
  }): Promise<ImSession>
  bind(input: { session_id: string; directory?: string; workspace_id?: string }): Promise<ImSession | null>
  model(input: { session_id: string; model?: OpencodeModel }): Promise<ImSession | null>
}

export type TaskSvc = {
  add(input: { im_session_id: string; session_id: string; inbound_id: string; directory?: string; workspace_id?: string }): Promise<Task>
  ack(id: string): Promise<void>
  run(id: string): Promise<void>
  wait(input: { id: string; req_type: "permission" | "question"; req: string }): Promise<void>
  hold(id: string): Promise<void>
  done(id: string, note?: string): Promise<void>
  fail(input: { id: string; err: string; note?: string }): Promise<void>
  abort(id: string, note?: string): Promise<void>
  link(input: { id: string; outbound_id: string }): Promise<void>
  note(input: { id: string; note: string }): Promise<void>
}

export type OpencodeSvc = {
  ensure(input: { directory?: string; workspace?: string; session_id?: string }): Promise<{ id: string }>
  session(id: string): Promise<OpencodeSession | null>
  sessions(input: { directory?: string; limit?: number; roots?: boolean }): Promise<OpencodeSession[]>
  status(input: { directory?: string; workspace?: string }): Promise<Record<string, OpencodeStatus>>
  commands(): Promise<OpencodeCommand[]>
  skills(): Promise<OpencodeSkill[]>
  agents(): Promise<OpencodeAgent[]>
  providers(): Promise<OpencodeProvider[]>
  mcps(): Promise<OpencodeMcp[]>
  prompt(input: {
    session_id: string
    text?: string
    parts?: PromptPart[]
    directory?: string
    workspace?: string
    agent?: string
    model?: OpencodeModel
  }): Promise<void>
  abort(input: { session_id: string; directory?: string; workspace?: string }): Promise<void>
  allow(input: { req: string; reply: "once" | "always" | "reject"; message?: string; directory?: string; workspace?: string }): Promise<void>
  answer(input: { req: string; answers: string[][]; directory?: string; workspace?: string }): Promise<void>
  reject(input: { req: string; directory?: string; workspace?: string }): Promise<void>
  command(input: {
    session_id: string
    command: string
    arguments: string
    directory?: string
    workspace?: string
  }): Promise<string | undefined>
  result?(input: { session_id: string; directory?: string; workspace?: string }): Promise<OpencodeResult>
  last(input: { session_id: string; directory?: string; workspace?: string }): Promise<string | undefined>
}

export type OpencodeEventSvc = {
  start(): Promise<void>
  stop(): Promise<void>
}

export type Render = {
  ack(input: { text: string }): RenderOut
  progress(input: { text: string; step?: string }): RenderOut
  approval(input: { req: string; tool: string; detail: string }): RenderOut
  question(input: { req: string; title: string; opts?: string[]; custom?: boolean }): RenderOut
  final(input: { text: string }): RenderOut
  err(input: { text: string }): RenderOut
}

export type Store = {
  get_session(input: { tenant_id: string; chat_id: string; thread_id?: string }): Promise<ImSession | null>
  get_session_by_opencode(session_id: string): Promise<ImSession | null>
  save_session(input: ImSession): Promise<void>
  get_pref(input: { scope: "chat" | "user"; tenant_id: string; chat_id?: string; user_id?: string }): Promise<RepoPref | null>
  save_pref(input: RepoPref): Promise<void>
  save_task(input: Task): Promise<void>
  get_task(id: string): Promise<Task | null>
  get_task_by_inbound(inbound_id: string): Promise<Task | null>
  get_last_task(session_id: string): Promise<Task | null>
  get_task_by_req(req: string): Promise<Task | null>
  list_tasks(input?: { status?: Task["status"][] }): Promise<Task[]>
  save_inbound(input: InboundEvent): Promise<void>
  get_inbound(id: string): Promise<InboundEvent | null>
  save_job(input: QueueJob): Promise<void>
  get_job(id: string): Promise<QueueJob | null>
  claim_job(): Promise<QueueJob | null>
  done_job(id: string): Promise<void>
  fail_job(input: { id: string; err?: string }): Promise<void>
  reset_jobs(input: { from: QueueJob["status"][]; to: QueueJob["status"] }): Promise<void>
  save_outbound(input: Outbound): Promise<void>
  get_outbound(task_id: string): Promise<Outbound | null>
  save_attachment(input: Attachment): Promise<void>
  get_attachment(input: { message_id: string; key: string }): Promise<Attachment | null>
  save_pending(input: Pending): Promise<void>
  get_pending(session_id: string): Promise<Pending | null>
  drop_pending(session_id: string): Promise<void>
  seen(key: string): Promise<boolean>
  mark(key: string): Promise<void>
  get_conn(name: ConnState["name"]): Promise<ConnState | null>
  set_conn(input: ConnState): Promise<void>
  close?(): Promise<void>
}

export type Gateway = {
  on_msg(input: InboundMessage): Promise<void>
}
