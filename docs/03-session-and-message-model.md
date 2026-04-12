# 03 Session And Message Model

## 核心对象

## 1. IM 会话

IM 会话是外部概念，用于表达用户在哪个聊天上下文中发起了请求。

建议字段：

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

## 2. OpenCode Session

OpenCode session 是实际执行上下文，具备历史消息、标题、summary、权限规则等状态。

首版建议：

- 一个飞书线程绑定一个 OpenCode session
- 私聊默认可简化为“一个 chat 一个活跃 session”
- 群聊必须以 thread 或 root message 为单位隔离

## 3. Inbound Envelope

飞书长连接进入系统后的标准化载荷。

```ts
type InboundEnvelope = {
  id: string
  platform: "feishu"
  channel: "long_conn"
  kind: "message"
  event_id: string
  tenant_id: string
  raw: unknown
  created_at: number
}
```

## 4. Inbound Message

消息事件转成统一的业务消息。

```ts
type InboundMessage = {
  id: string
  envelope_id: string
  im_session_id: string
  user_id: string
  text: string
  assets: Array<{
    kind: "image" | "file"
    key: string
    name?: string
    mime?: string
    path?: string
    url?: string
  }>
  command?: {
    name: string
    args: string
  }
  event_type: "im.message.receive_v1"
  created_at: number
}
```

## 5. Outbound Message

发送回飞书的消息记录。

```ts
type OutboundMessage = {
  id: string
  im_session_id: string
  feishu_message_id: string
  kind: "ack" | "progress" | "approval" | "question" | "final" | "error"
  status: "sent" | "updated" | "failed"
  session_id: string
  request_id?: string
  payload: unknown
  created_at: number
  updated_at: number
}
```

## 幂等主键

长连接模式仍然需要按飞书事件 ID 做幂等处理。

建议来源：

- 消息事件：使用飞书事件头中的 `event_id`
- 卡片动作：使用动作事件 ID 或由 `request_id + action + user_id` 派生

无论是消息事件还是卡片动作，都应在进入业务处理前先写入幂等表。

## 事件模型

IMUI 只需要关心少量关键事件。

## 1. 执行启动

- `message.updated`
- assistant message 创建成功

用途：

- 创建或更新“处理中”占位消息

## 2. 文本增量

- `message.part.delta`
- `message.part.updated`

用途：

- 收集文本片段
- 做节流后刷新执行中消息

首版建议不逐 token 更新飞书消息，而是基于 1 到 2 秒窗口聚合。

## 3. 工具调用

- `message.part.updated`
- 其中 `part.type === "tool"`

用途：

- 展示“正在读取文件”“正在执行命令”“正在搜索代码”等阶段
- 对高风险工具触发权限审批

## 4. 状态结束

- `session.status`
- 当 `status.type === "idle"` 时表示该轮执行已结束

用途：

- 输出最终结果
- 收口 UI 状态

## 5. 错误

- `session.error`

用途：

- 在飞书里展示用户可理解的报错
- 给后台标记本轮执行失败

## 6. 权限请求

- `permission.asked`
- `permission.replied`

用途：

- 发送审批卡片
- 审批完成后继续执行

## 7. 问题回问

- `question.asked`
- `question.replied`
- `question.rejected`

用途：

- 发送选择题或补充输入卡片
- 把用户回答继续送回 OpenCode

## 状态机

建议以单轮用户输入为单位维护任务状态。

```text
queued
  -> running
  -> waiting_permission
  -> waiting_question
  -> waiting_attachment
  -> completed
  -> failed
  -> aborted
```

### queued

刚收到飞书消息，已完成去重，但还没成功发给 OpenCode。

### acked

飞书长连接事件已经被快速确认，但后台任务还没开始执行。

### running

已经成功调用 `prompt_async`，正在等待事件流产出。

### waiting_permission

收到了 `permission.asked`，当前执行被阻塞，等待用户审批。

### waiting_question

收到了 `question.asked`，等待用户回答。

### waiting_attachment

收到了图片或文件，但当前轮还缺少文字说明。

此时网关会先缓存附件，并等待用户在同一 thread 中继续发送一条文本消息，再把“文本 + 附件”一起转成 OpenCode `parts`。

### completed

收到 `session.status=idle`，且本轮没有未处理错误。

### failed

收到 `session.error`，或网关无法处理飞书长连接事件 / OpenCode 事件。

### aborted

用户主动取消，或服务端调用了 `session.abort`。

## 会话路由策略

## 私聊

默认以 `chat_id` 绑定一个活跃 session。

策略：

- 若最近 session 仍活跃，直接复用
- 若用户输入 `/new`，强制新建 session
- 若 session 长时间未使用，可自动归档并重建

## 群聊

默认以 thread 粒度隔离。

策略：

- 新 thread 首条消息必须 `@bot`
- 同一 thread 内如果已建立 session，可直接继续回复
- 优先使用飞书 thread 或 root message 维持上下文
- 不同 thread 不共享 session

## 多仓路由

会话必须携带 repo 上下文，建议三种来源：

1. 用户显式命令，例如 `/repo xxx`
2. 群级默认配置
3. 用户级默认配置
4. 进程级全局默认配置

`repo` 上下文可以有两种表达：

- `directory`: 直接指定本地目录路径
- `workspace`: 指定 OpenCode 的逻辑工作区 ID

推荐理解：

- `directory` 用来回答“操作哪个文件夹”
- `workspace` 用来回答“操作哪个已登记的工作区”
- 如果当前部署只是单机单目录开发，通常只需要 `directory`
- 如果一个聊天需要稳定绑定到某个 worktree、分支环境或远端目标，`workspace` 会更合适

当前实现：

- `/repo <directory>`: 绑定当前 session
- `/repo --chat <directory>`: 绑定当前聊天默认目录
- `/repo --me <directory>`: 绑定当前用户默认目录
- `/repo --workspace <workspace>`: 绑定当前 session 的 workspace
- `/repo <directory> --workspace <workspace>`: 同时绑定目录和 workspace
- 新 session 的目录优先级为：当前会话显式绑定 > 聊天默认 > 用户默认 > 全局默认

说明：

- 当前正式实现主要围绕 `directory` 落地
- `workspace` 仍保留在模型和 OpenCode 接口层，作为后续扩展能力
- 后续如果需要在 IM 中切换逻辑工作区，可以在同一套优先级上把 `workspace` 一并接入

没有 repo 时，系统应该提示用户先绑定，而不是盲目发到某个目录。

## 长连接运行状态

除了业务任务状态，还需要单独维护飞书连接状态。

建议：

```ts
type ConnState = {
  name: "message" | "card"
  status: "connecting" | "ready" | "reconnecting" | "stopped" | "error"
  updated_at: number
  err?: string
}
```

用途：

- 监控当前是否还能正常接收消息
- 发现长连接断开后自动告警或重连
- 在多实例部署时识别是否存在重复消费者
