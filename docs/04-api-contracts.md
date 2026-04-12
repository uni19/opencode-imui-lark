# 04 API Contracts

## Feishu 侧接入方式

飞书侧不再通过公网 webhook 推送请求，而是通过长连接把事件和新版卡片交互发送给本地或内网 Gateway Runtime。

因此接口分成两层：

- 飞书长连接输入接口
- OpenCode HTTP / SSE 输出接口

## OpenCode 侧接口

优先使用 `@opencode-ai/sdk/v2` 封装，必要时再直接调用 HTTP。

## 1. 创建会话

用途：

- 新对话开始时创建 OpenCode session
- 可在创建时注入更保守的 permission 规则

建议调用：

```ts
client.session.create({
  body: {
    title,
    permission,
    workspaceID,
  },
})
```

说明：

- `workspaceID` 是 OpenCode 的逻辑工作区 ID，不是目录路径
- 如果只是在本机某个 repo 里运行，一般更常见的是传 `directory`
- 当服务端已经配置了 workspace 路由时，再由调用方显式传入 `workspaceID`

## 2. 异步发送消息

用途：

- 作为 IM 主入口
- 立即返回，后续依赖事件流回推

建议调用：

```ts
client.session.promptAsync({
  sessionID,
  parts: [{ type: "text", text }],
  agent,
  model,
  system,
})
```

对于图片或文件输入，可改为：

```ts
client.session.promptAsync({
  sessionID,
  parts: [
    { type: "text", text: "请看看这个附件" },
    { type: "file", url, mime, filename },
  ],
})
```

## 3. 订阅事件

两种模式：

- 单实例或单 repo 优先 `/event`
- 聚合多个目录时可用 `/global/event`

建议封装成：

```ts
subscribeEvents({
  directory,
  workspace,
  onEvent,
})
```

说明：

- `directory` 和 `workspace` 只需命中其中一种路由上下文即可
- 对多实例或远端工作区场景，优先用 `workspace`
- 对单目录本地开发场景，优先用 `directory`

## 4. 响应权限

用途：

- 用户在飞书卡片上审批工具调用

建议调用：

```ts
client.permission.reply({
  requestID,
  reply: "once" | "always" | "reject",
  message,
})
```

## 5. 响应问题

用途：

- 用户在飞书里回答选择题或补充信息

建议调用：

```ts
client.question.reply({
  requestID,
  answers,
})
```

拒绝时：

```ts
client.question.reject({
  requestID,
})
```

## 6. 取消会话

用途：

- 用户主动发送 `/abort`

建议调用：

```ts
client.session.abort({
  sessionID,
})
```

## Gateway 内部接口

建议把飞书接入层和领域层拆开，内部提供一组稳定服务。

## 1. FeishuConnService

```ts
type FeishuConnService = {
  onEvent(input: InboundEnvelope): Promise<{ ok: true }>
  start(): Promise<void>
  stop(): Promise<void>
}
```

职责：

- 接收飞书长连接事件
- 做最小校验和幂等
- 快速入队并确认

## 2. IngestService

```ts
type IngestService = {
  onMessage(input: InboundMessage): Promise<void>
  onCardAction(input: CardAction): Promise<void>
}
```

## 3. SessionService

```ts
type SessionService = {
  resolve(input: ResolveInput): Promise<ResolvedSession>
  reset(input: ResetInput): Promise<ResolvedSession>
  bindRepo(input: BindRepoInput): Promise<void>
}
```

## 4. TaskService

```ts
type TaskService = {
  enqueue(input: StartTaskInput): Promise<TaskRecord>
  markAcked(id: string): Promise<void>
  markRunning(id: string): Promise<void>
  markWaitingPermission(id: string, requestID: string): Promise<void>
  markWaitingQuestion(id: string, requestID: string): Promise<void>
  markCompleted(id: string): Promise<void>
  markFailed(id: string, err: string): Promise<void>
}
```

## 5. RenderService

```ts
type RenderService = {
  ack(input: AckRenderInput): Promise<OutboundMessage>
  progress(input: ProgressRenderInput): Promise<void>
  approval(input: ApprovalRenderInput): Promise<OutboundMessage>
  question(input: QuestionRenderInput): Promise<OutboundMessage>
  final(input: FinalRenderInput): Promise<void>
  error(input: ErrorRenderInput): Promise<void>
}
```

## 6. FeishuApiService

```ts
type FeishuApiService = {
  sendMessage(input: SendMessageInput): Promise<{ message_id: string }>
  replyMessage(input: ReplyMessageInput): Promise<{ message_id: string }>
  patchCard(input: PatchCardInput): Promise<void>
}
```

职责：

- 作为飞书出站能力统一封装
- 不暴露底层 HTTP 细节给业务层

## 长连接输入约束

### 快速确认

飞书长连接收到事件后，`FeishuConnService.onEvent()` 只做以下事情：

1. 解析事件
2. 校验是否支持
3. 去重
4. 投递异步任务
5. 返回确认

不在这一层直接调用 OpenCode。

### 支持的输入事件

首版建议最小事件集：

- `im.message.receive_v1`

### 不支持的输入协议

- 旧版卡片回传协议
- 依赖公网 webhook 的开发者服务器回调模式

## 存储表建议

## 1. im_sessions

- 用于映射飞书上下文和 OpenCode session

字段：

- `id`
- `platform`
- `tenant_id`
- `chat_id`
- `thread_id`
- `root_message_id`
- `session_id`
- `directory`
- `workspace_id`
- `state`
- `created_at`
- `updated_at`

## 2. im_tasks

- 一条用户输入对应一条任务

字段：

- `id`
- `im_session_id`
- `session_id`
- `inbound_message_id`
- `status`
- `waiting_request_type`
- `waiting_request_id`
- `error`
- `created_at`
- `updated_at`

## 3. outbound_messages

- 保存飞书发出的消息和卡片

字段：

- `id`
- `task_id`
- `feishu_message_id`
- `kind`
- `payload_json`
- `created_at`
- `updated_at`

## 4. idempotency_keys

- 处理飞书事件重试

字段：

- `key`
- `source`
- `channel`
- `expired_at`

## 5. event_offsets

- 如果事件桥后续切换成队列或自定义游标，可保留扩展

## 6. conn_state

- 保存长连接运行状态

字段：

- `name`
- `status`
- `updated_at`
- `err`

## 飞书卡片建议

首版至少需要三种卡片：

### 审批卡片

展示：

- 工具名
- 风险说明
- `1 / 2 / 3` 序号提示

### 问题卡片

支持：

- 单选序号回复
- 多选序号回复
- 自定义文本输入

### 结果卡片

展示：

- 执行摘要
- agent/model
- repo
- 状态
- 可选的 diff 摘要

## 推荐封装边界

为了避免飞书和 OpenCode 两侧协议耦合过深，建议边界如下：

- `adapter/feishu`: 只处理飞书长连接和飞书 API
- `gateway/`: 只处理业务编排
- `opencode/`: 只处理 OpenCode SDK 和事件桥
- `render/`: 只处理消息和卡片渲染
- `storage/`: 只处理状态持久化
