# 03 会话与消息模型

## 文档状态

本文定义 OMO 目标数据模型。当前代码仍保留 `Outbound` 单行镜像、session-owned `Pending`、以及等待态 task 克隆等兼容结构；这些兼容结构在迁移期存在，但不再是目标语义。

## 三个主对象

### 1. ImSession：前台 thread -> foreground session 指针

`ImSession` 描述的是“当前这个 Feishu thread 前台绑定到哪个 OpenCode session”，它解决的是前台路由，而不是所有活跃任务的全局真相。

```ts
type ImSession = {
  id: string
  platform: "feishu"
  tenant_id: string
  chat_id: string
  thread_id?: string
  root_message_id?: string
  user_id?: string
  session_id: string
  directory?: string
  workspace_id?: string
  state: "active" | "archived" | "error"
  created_at: number
  updated_at: number
}
```

要点：

- 私聊默认以 `chat_id` 维持一个前台 session 指针
- 群聊默认以 `thread_id` 或 `root_message_id` 隔离
- 同一个 thread 任何时刻只有一个 foreground session 指针
- 旧 task 可以在后台继续跑，但不会因此改写当前前台指针

### 2. Task：一次 originating user turn

Task 对应一次真实的用户轮次，而不是一次“可见等待交互”。

```ts
type Task = {
  id: string
  im_session_id: string
  session_id: string
  inbound_id: string
  reply_anchor_message_id: string
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
  req_id?: string
  note?: string
  outbound_id?: string // compat: 当前可 patch 槽位
  result_hash?: string
  terminal_kind?: "final" | "error" | "aborted"
  terminal_outbound_id?: string
  superseded_by_task_id?: string
  created_at: number
  updated_at: number
}
```

要点：

- `reply_anchor_message_id` 是所有 Feishu reply 的不可变锚点
- `req_type` / `req_id` 只描述当前前台可见的 head wait，不代表完整 wait 历史
- `outbound_id` 只是兼容窗口里的可见槽位指针，不再代表“这个 task 只有一个 outbound”
- `superseded_by_task_id` 用来记录“新 prompt 抢前台后，旧 task 进入后台继续跑”的关系

### 3. AssistantOutbound：助手发言账本

每个 task 拥有 1:N 的 `assistant_outbound` 子记录，所有助手侧发言都落在这里。

```ts
type AssistantOutbound = {
  id: string
  task_id: string
  session_id: string
  seq: number
  kind:
    | "ack"
    | "progress"
    | "approval"
    | "question"
    | "intermediate"
    | "final"
    | "error"
  action: "reply" | "patch" | "deferred"
  origin_inbound_id: string
  origin_message_id: string
  req_key?: string
  terminal: boolean
  feishu_message_id?: string
  payload: unknown
  created_at: number
  updated_at: number
}
```

要点：

- `seq` 在单个 task 内单调递增
- `action="deferred"` 表示事件已经落账，但当前不应该立刻在前台 thread 里显示
- `terminal=true` 只允许出现在 `final` 或 `error` 上
- 同一个 task 可以有很多条 `progress` / `intermediate`，但终态最多一条

### 4. PendingAttachment：task-owned hold

attachment-only 输入不再挂在 session 上，而是挂在具体 task 上。

```ts
type PendingAttachment = {
  task_id: string
  session_id: string
  origin_inbound_id: string
  origin_message_id: string
  assets: Array<{
    kind: "image" | "file"
    key: string
    name?: string
    mime?: string
    path?: string
    url?: string
  }>
  created_at: number
  updated_at: number
}
```

这样 `/new`、`/session`、recover、background completion 都不会把附件等待串到别的 task。

### 5. VisibleOutboundMirror：兼容窗口

迁移期仍然保留一个“当前可 patch 槽位”的兼容镜像：

```ts
type VisibleOutboundMirror = {
  task_id: string
  msg_id: string
  kind: string
  payload: unknown
  created_at: number
  updated_at: number
}
```

它的语义是“当前前台槽位长什么样”，不是“任务所有 outbound 的完整历史”。完整历史必须看 `assistant_outbound`。

## 事件语义

### 1. `message.updated` / `message.part.updated`

- 产生 `progress` 或 `intermediate` 类 `assistant_outbound`
- 允许节流 patch 当前可见槽位
- 不直接决定 task 完成

### 2. `permission.asked` / `question.asked`

- 在同一个 task 下追加 unresolved wait outbound
- 如果当前 task 在前台且该 wait 是队头，则立刻可见
- 如果 task 已在后台，或该 wait 不是当前队头，则只记为 `deferred`

### 3. `session.status=idle`

- 只记录 checkpoint，不直接把 task 置为 `completed`
- 需要结合 `result_hash` 和 unresolved wait 做 reconciliation
- 重复收到相同 `result_hash` 的 idle checkpoint 必须是幂等 no-op

### 4. `session.error`

- 如果 task 尚未 terminal，可产生唯一的 terminal error outbound
- 如果 task 已 terminal，后续 error 只能视为幂等命中，不能二次收口

### 5. 用户回复与继续执行

- `permission.replied`、`question.replied`、附件补充文本都继续推进同一个 task
- 这些回复不应新建 task，更不应把 wait 回答串给后台的别的 task

## Task 状态机

```text
queued -> acked -> running
running -> waiting_permission -> running
running -> waiting_question -> running
running -> waiting_attachment -> running
running -> completed | failed | aborted
```

关键说明：

- `idle` 不是 task 主状态，而是 runtime checkpoint 事件
- 同一个 task 可以经历多次 `running <-> waiting_*`
- 同一个 task 可以经历多次 idle checkpoint
- `completed | failed | aborted` 一旦写入就不可逆

## 会话路由规则

### 1. 一个 OpenCode session 同时最多承载一个开放用户轮次

OMO 目标模型不允许多个未收口 user turn 共用一个 OpenCode `session_id`。这不是实现洁癖，而是为了避免 reply 归属、idle 终态、wait 队列、result_hash 对账全部打结。

### 2. 新普通 prompt 遇到 live 非等待 task 时，必须 fresh-session rotation

如果当前前台 task 仍在 `queued | acked | running`，而用户又发来新的普通 prompt：

- 不能继续复用当前 `session_id`
- 必须 `route.reset(...)` 到 fresh OpenCode session
- 新 prompt 生成新 task
- 旧 task 可通过 `superseded_by_task_id` 标记后进入后台继续跑

### 3. 文本回复只绑定前台 task 的 head unresolved wait

普通文本如果不是新 prompt，就只能回复：

- 当前前台 task 的 head unresolved wait

它不能抢答后台 task，也不能跨 task 命中旧的 wait 记录。

### 4. `/session` 和 `/new` 只切前台，不改写旧 task 的 reply anchor

- `/session` 切的是前台 session 指针
- `/new` 创建的是新的前台 session
- 已存在 task 的 `reply_anchor_message_id` 不能因切换而改变

## 必须成立的最终不变量

- 一次用户轮次只创建一个 task
- 一个 task 可以拥有多个 `assistant_outbound`
- 一个 task 最多只有一个 terminal outbound
- `session.status=idle` 单独出现时不能视为完成
- 后台 wait 必须延迟显示，直到 replay
- 背景完成/失败必须仍然回到 originating reply anchor
- `pending_attachment` 的归属必须是 `task_id`，不是 `session_id`
