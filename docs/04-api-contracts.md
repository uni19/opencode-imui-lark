# 04 API 合约

## 文档状态

本文描述 OMO 目标合约，而不是当前代码已经完整提供的接口清单。现有外部 OpenCode / Feishu API 基本不变，主要变化发生在 Gateway 内部语义、存储模型和 runtime 对 `idle` 的解释方式上。

## 外部合约

### 1. Feishu 输入仍然走长连接

Feishu 侧不通过公网 webhook 直接推请求，而是通过长连接把消息事件和新卡片交互发送给本地或内网 Gateway Runtime。

这条约束不变：

- 快速 ack
- 入站先落幂等 / 队列
- 不在回调线程里同步执行 OpenCode

### 2. OpenCode 会话接口保持原子调用

目标设计不要求改 OpenCode 原子接口，仍然围绕这些调用组织：

```ts
client.session.create({ body: { title, permission, workspaceID } })
client.session.promptAsync({ sessionID, parts, agent, model, system })
client.permission.reply({ requestID, reply, message })
client.question.reply({ requestID, answers })
client.question.reject({ requestID })
client.session.abort({ sessionID })
```

变化点不在参数形状，而在调用时机：

- 新普通 prompt 遇到 live 非等待 task 时，必须先 `SessionSvc.reset(...)` 到 fresh session，再 `promptAsync`
- 权限、问题、附件补充文本回复的目标永远是同一个 task，而不是新建 task

### 3. Event Bridge 的语义需要重写

Gateway 仍然消费 OpenCode `/event` 或 `/global/event`，但语义改成：

- `message.*` 负责产出非终态 outbound
- `permission.asked` / `question.asked` 负责挂 wait outbound
- `session.status=idle` 只触发 checkpoint / reconciliation
- `session.error` 只在 task 尚未 terminal 时产出唯一 terminal error

关键约束：`session.status=idle` 不能再直接等价为 `task.done()`。

## Gateway 内部服务合约

### 1. SessionService

```ts
type SessionService = {
  resolve(input: ResolveInput): Promise<ResolvedSession>
  reset(input: ResetInput): Promise<ResolvedSession>
  switch(input: SwitchInput): Promise<ResolvedSession>
  bindRepo(input: BindRepoInput): Promise<void>
}
```

约束：

- `resolve` 只回答“当前前台该去哪个 session”
- `reset` 用于 `/new` 和 superseding prompt 的 fresh-session rotation
- `switch` 用于切回已有 session 并触发等待态 replay

### 2. TaskService

```ts
type TaskService = {
  create(input: StartTaskInput): Promise<Task>
  markAcked(id: string): Promise<void>
  markRunning(id: string): Promise<void>
  markWait(id: string, wait: WaitState): Promise<void>
  checkpointIdle(id: string, resultHash?: string): Promise<void>
  linkVisibleSlot(input: { id: string; outbound_id: string }): Promise<void>
  closeTerminal(input: {
    id: string
    status: "completed" | "failed" | "aborted"
    terminal_kind: "final" | "error" | "aborted"
    terminal_outbound_id?: string
    result_hash?: string
    error?: string
  }): Promise<boolean>
  supersede(input: { id: string; superseded_by_task_id: string }): Promise<void>
}
```

约束：

- `checkpointIdle` 不得直接把 task 置成 `completed`
- `closeTerminal(...)` 需要做 terminal 幂等保护；已经 terminal 的 task 再次 close 必须返回 no-op
- `markWait(...)` 只更新当前 head wait 的可见状态，不承担完整 wait 历史

### 3. AssistantOutboundStore

```ts
type AssistantOutboundStore = {
  append(outbound: AssistantOutbound): Promise<void>
  listByTask(task_id: string): Promise<AssistantOutbound[]>
  listOpenWaits(task_id: string): Promise<AssistantOutbound[]>
  headWait(task_id: string): Promise<AssistantOutbound | undefined>
  getVisibleSlot(task_id: string): Promise<VisibleOutboundMirror | undefined>
}
```

约束：

- `append(...)` 是目标真相写入点
- `getVisibleSlot(...)` 只是兼容窗口里的前台 patch 指针
- patch fallback 不能抹掉旧 outbound 历史，只能新追加 child outbound 并推进 visible slot

### 4. PendingAttachmentStore

```ts
type PendingAttachmentStore = {
  save(pending: PendingAttachment): Promise<void>
  get(task_id: string): Promise<PendingAttachment | undefined>
  drop(task_id: string): Promise<void>
}
```

约束：

- 归属键是 `task_id`
- 如需兼容老库里的 `pending_attachment(session_id)`，只能 lazy migrate，不能继续把 session-owned 结构当目标模型

### 5. RenderService

```ts
type RenderService = {
  ack(input: AckRenderInput): RenderOut
  progress(input: ProgressRenderInput): RenderOut
  approval(input: ApprovalRenderInput): RenderOut
  question(input: QuestionRenderInput): RenderOut
  intermediate(input: IntermediateRenderInput): RenderOut
  final(input: FinalRenderInput): RenderOut
  error(input: ErrorRenderInput): RenderOut
}
```

约束：

- `RenderOut` 仍然是一条原子消息 payload，不扩成数组 API
- intermediate 与 final 必须显式区分，不能都用“绿色完成卡”但不给终态标识

### 6. FeishuApiService

```ts
type FeishuApiService = {
  sendMessage(input: SendMessageInput): Promise<{ message_id: string }>
  replyMessage(input: ReplyMessageInput): Promise<{ message_id: string }>
  patchCard(input: PatchCardInput): Promise<void>
}
```

约束：

- 外部 Feishu API 仍然是一条消息一次 send/reply/patch
- fan-out 逻辑留在 `boot.ts` / runtime，不把 Feishu API 包装成“批量多消息”接口

## 存储合约

### 1. `im_session`

保存 Feishu thread 到 foreground OpenCode session 的映射。

### 2. `task`

除现有字段外，目标模型新增或强化这些字段：

- `reply_anchor_message_id`
- `result_hash`
- `terminal_kind`
- `terminal_outbound_id`
- `superseded_by_task_id`
- `outbound_id`（兼容窗口保留）

### 3. `assistant_outbound`

目标表建议至少包含：

- `id`
- `task_id`
- `session_id`
- `seq`
- `kind`
- `action` (`reply | patch | deferred`)
- `origin_inbound_id`
- `origin_message_id`
- `req_key`
- `terminal`
- `feishu_message_id`
- `payload_json`
- `created_at`
- `updated_at`

### 4. `outbound_message`

迁移期继续保留，作为当前 visible slot 的 compat mirror，不再承担完整历史账本职责。

### 5. `pending_attachment_task`

目标表建议至少包含：

- `task_id`（主键）
- `session_id`（可选冗余字段，便于恢复和兼容迁移）
- `origin_inbound_id`
- `origin_message_id`
- `data_json`
- `created_at`
- `updated_at`

### 6. `seen_event` / `queue_job` / `conn_state`

这几张表继续承担：

- 事件幂等
- 队列恢复
- 连接状态观测

它们不需要为 OMO 语义重写，但必须继续配合 terminal idempotency、wait replay 和 reconnect throttling。

## 必须成立的关键合约

- `session.status=idle` 单独出现时不能完成 task
- 一个 task 最多只有一个 terminal outbound
- 每个 outbound 都必须带 `origin_inbound_id + origin_message_id`
- `store.get_outbound(task_id)` 在兼容窗口里仍然返回当前 visible slot
- patch fallback 必须保留 outbound 历史，而不是覆盖它
- 多个开放 user turn 不能共享一个 OpenCode `session_id`
