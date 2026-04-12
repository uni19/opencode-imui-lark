# 08 Module Sketch

## 目标

本文件补充“模块职责 + 接口草图 + 启动顺序”，让下一轮开发可以直接从接口开始切文件。

## 核心服务

## 1. `FeishuConn`

职责：

- 建立长连接
- 接收消息事件
- 快速确认

建议接口：

```ts
type FeishuConn = {
  start(): Promise<void>
  stop(): Promise<void>
}
```

输入后不直接做业务处理，而是把事件转给 `Gateway`.

## 2. `FeishuApi`

职责：

- 发消息
- 回复消息
- 更新卡片

建议接口：

```ts
type FeishuApi = {
  send(input: SendMsg): Promise<{ id: string }>
  reply(input: ReplyMsg): Promise<{ id: string }>
  patch(input: PatchCard): Promise<void>
}
```

## 3. `Gateway`

职责：

- 接收 `InboundMessage`
- 做会话路由
- 创建任务

建议接口：

```ts
type Gateway = {
  on_msg(input: InboundMessage): Promise<void>
}
```

## 4. `SessionSvc`

职责：

- 找会话
- 新建会话
- 绑定 repo/workspace

约束：

- `directory` 表示当前会话绑定的真实目录
- `workspace` 表示当前会话绑定的 OpenCode 逻辑工作区
- 两者可以同时存在，但在简单场景下通常只需要维护 `directory`
- `SessionSvc` 应该把它们视为同一类“路由上下文”，而不是把 `workspace` 当成目录别名

建议接口：

```ts
type SessionSvc = {
  resolve(input: ResolveInput): Promise<ResolvedSession>
  reset(input: ResetInput): Promise<ResolvedSession>
  bind(input: BindInput): Promise<void>
}
```

## 5. `TaskSvc`

职责：

- 记录任务状态
- 更新等待审批 / 问答 / 完成 / 失败状态

建议接口：

```ts
type TaskSvc = {
  add(input: StartTaskInput): Promise<Task>
  ack(id: string): Promise<void>
  run(id: string): Promise<void>
  wait(id: string, kind: "permission" | "question", req: string): Promise<void>
  done(id: string): Promise<void>
  fail(id: string, err: string): Promise<void>
}
```

## 6. `Queue`

职责：

- 入队
- 同 session 串行
- 后台 worker

建议接口：

```ts
type Queue = {
  push(input: Job): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}
```

## 7. `OpencodeSvc`

职责：

- 封装 OpenCode SDK
- 发送 prompt
- 响应权限和问题

建议接口：

```ts
type OpencodeSvc = {
  ensure(input: EnsureSessionInput): Promise<{ id: string }>
  sessions(input: ListSessionsInput): Promise<SessionSummary[]>
  status(input: SessionStatusInput): Promise<Record<string, SessionStatus>>
  commands(): Promise<CommandInfo[]>
  skills(): Promise<SkillInfo[]>
  prompt(input: PromptRunInput): Promise<void>
  command(input: CommandRunInput): Promise<string | undefined>
  abort(input: { session_id: string }): Promise<void>
  allow(input: PermissionReplyInput): Promise<void>
  answer(input: QuestionReplyInput): Promise<void>
  reject(input: { req: string }): Promise<void>
}
```

## 8. `OpencodeEvent`

职责：

- 订阅 `/event`
- 转成内部事件
- 把事件交给渲染和任务层

建议接口：

```ts
type OpencodeEvent = {
  start(): Promise<void>
  stop(): Promise<void>
}
```

## 9. `Render`

职责：

- 生成飞书文本
- 生成飞书卡片
- 节流刷新

建议接口：

```ts
type Render = {
  ack(input: AckView): RenderOut
  progress(input: ProgressView): RenderOut
  approval(input: ApprovalView): RenderOut
  question(input: QuestionView): RenderOut
  final(input: FinalView): RenderOut
  err(input: ErrorView): RenderOut
}
```

## 10. `Store`

职责：

- 所有状态持久化

建议接口：

```ts
type Store = {
  save_session(input: ImSession): Promise<void>
  get_session(input: SessionQuery): Promise<ImSession | null>
  save_task(input: Task): Promise<void>
  save_msg(input: OutboundMessage): Promise<void>
  seen(key: string): Promise<boolean>
  mark(key: string): Promise<void>
  set_conn(input: ConnState): Promise<void>
}
```

## 启动顺序

建议启动顺序如下：

1. 加载配置
2. 初始化数据库和仓储
3. 初始化飞书出站 API
4. 初始化 OpenCode SDK 和事件桥
5. 初始化队列
6. 初始化 Gateway
7. 启动飞书长连接
8. 启动健康检查和监控

## 消息主路径

```text
FeishuConn
  -> Gateway.on_msg
    -> SessionSvc.resolve
    -> TaskSvc.add
    -> Queue.push
      -> OpencodeSvc.prompt
        -> OpencodeEvent
          -> Render
          -> FeishuApi
```

## 审批主路径

```text
OpencodeEvent(permission.asked)
  -> Render.approval
  -> FeishuApi.patch/send
  -> User text reply
  -> FeishuConn(im.message.receive_v1)
  -> OpencodeSvc.allow
```

## 问答主路径

```text
OpencodeEvent(question.asked)
  -> Render.question
  -> FeishuApi.patch/send
  -> User text reply
  -> FeishuConn(im.message.receive_v1)
  -> OpencodeSvc.answer
```

## 设计上的故意留白

以下部分本轮先不锁死：

- 具体数据库是 SQLite、Postgres 还是别的
- 具体 HTTP 框架是 Hono、Fastify 还是原生服务
- 长连接使用官方 SDK 还是 CLI/自定义封装
- 队列是内存实现、SQLite 实现还是外部消息队列

这样可以在下一轮依据实际部署环境再做选择。
