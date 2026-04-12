# 02 Architecture

## 总览

推荐采用“飞书长连接客户端 + 本地/内网 Gateway Runtime + OpenCode 运行时”的三层结构。

```text
Feishu User
   |
   v
Feishu Open Platform
   <-> Feishu Long Connection Client
        |- Message Event Stream
        |- Card Action Callback Stream
        |- Ack Fast Path
        |
        v
Gateway Runtime
   |- Dedup / Idempotency
   |- Queue / Dispatcher
   |- Session Router
   |- Message Renderer
   |- Card Action Handler
   |- OpenCode Event Bridge
   |
   +-> OpenCode Server
   |    |- session.create
   |    |- session.prompt_async
   |    |- permission.reply
   |    |- question.reply
   |    |- question.reject
   |    |- /event
   |    |- /global/event
   |
   +-> Feishu Send API
```

## 设计原则

### 1. 无公网入口优先

默认部署前提是机器没有公网 IP 和自有域名，但具备公网出站能力。因此接入设计必须建立在飞书长连接而不是公网 webhook 之上。

### 2. 协议翻译和推理执行分离

飞书层负责处理长连接、消息卡片、事件去重、快速确认和回调协议。OpenCode 继续只负责会话、上下文、工具、执行和事件。

### 3. 以 sessionID 为核心主键

飞书里的 chat、thread、message 只是外部交互载体。真正的执行上下文仍然由 OpenCode sessionID 作为权威标识。

### 4. 执行和回推解耦

入口请求不等待模型完成，而是调用 `prompt_async` 后快速返回。所有中间状态和结果通过事件桥异步回推给飞书。

### 5. 长连接快速确认，重逻辑异步化

飞书长连接模式下，收到消息事件或卡片动作后需要尽快完成确认。Gateway 不在长连接回调线程中执行 OpenCode 推理，而是快速落库、入队，再由后台 worker 异步推进。

### 6. 首版优先可观测和可恢复

IM 集成最大的痛点不是“能不能调用成功”，而是“失败后能不能看懂和续上”。因此数据库设计、日志 trace 和幂等处理需要从第一天就有。

## 模块拆分

## 1. Feishu Connection Manager

职责：

- 使用飞书 SDK 或官方协议与开放平台建立长连接
- 监听消息事件，例如 `im.message.receive_v1`
- 对接收事件执行快速确认
- 处理断线重连、心跳和单实例锁
- 将飞书原始载荷映射成内部标准事件

输出给内部层的统一结构建议：

```ts
type Inbound = {
  platform: "feishu"
  kind: "message"
  delivery: "long_conn"
  event_id: string
  tenant: string
  user: {
    id: string
    name?: string
  }
  chat: {
    id: string
    type: "p2p" | "group"
    thread?: string
  }
  message: {
    id: string
    text: string
    mentions: string[]
    reply_to?: string
  } | null
  action?: {
    token: string
    value?: Record<string, unknown>
  }
  raw: unknown
}
```

## 2. Queue / Dispatcher

职责：

- 承接长连接层快速确认后的异步任务
- 做去重、限流、顺序化和任务拆分
- 将消息事件和卡片事件分别路由到对应 worker
- 避免在长连接回调线程中执行重操作

## 3. Session Router

职责：

- 把飞书 chat/thread 映射到 OpenCode sessionID
- 把 tenant/user/chat 映射到默认 repo 或 workspace
- 管理会话复用、新建和过期策略

建议映射优先级：

1. `chat_id + thread_id`
2. `chat_id + root_message_id`
3. `chat_id` 的最近活跃会话

## 4. OpenCode Client

职责：

- 封装 `@opencode-ai/sdk/v2`
- 统一注入 `baseUrl`、Basic Auth、`directory` 或 `workspace`
- 提供稳定的领域接口，而不是把 SDK 直接散落到业务里

建议封装的方法：

- `ensureSession`
- `sendPromptAsync`
- `abortSession`
- `listPendingPermissions`
- `replyPermission`
- `listPendingQuestions`
- `replyQuestion`
- `rejectQuestion`
- `subscribeEvents`

`workspace` 说明：

- `directory` 是本地目录路径，例如 `/Users/bytedance/workspace/opencode`
- `workspace` 是 OpenCode 控制面的逻辑工作区 ID，不等于目录路径
- 当请求未携带 `workspace` 时，服务端按当前 `directory/project` 直接处理
- 当请求携带 `workspace` 时，服务端会先解析该工作区，再把请求路由到它对应的目标目录或远端实例
- 对 IMUI 来说，`workspace` 适合表达“逻辑环境”或“命名好的工作上下文”；`directory` 更适合本机单目录开发

建议：

- 首版默认使用 `directory`
- 只有在 OpenCode 已经启用了多 workspace、worktree、远端实例或分环境路由时，再把 `workspace` 暴露给 IM 命令层

## 5. OpenCode Event Bridge

职责：

- 常驻订阅 `/event` 或 `/global/event`
- 过滤属于当前项目目录或 sessionID 的事件
- 更新本地会话状态
- 把状态渲染成飞书消息或卡片

这是整个系统里最关键的增量价值层。

## 6. Feishu Send / Renderer

职责：

- 把 OpenCode 事件渲染成飞书文本或卡片
- 做文本裁剪、摘要、节流和合并更新
- 区分“占位消息”“执行中消息”“审批卡片”“最终结果消息”
- 调用飞书发送消息、更新卡片和回复消息 API

## 7. Storage

职责：

- 保存会话映射
- 保存飞书消息和 OpenCode 消息对应关系
- 记录幂等 key
- 记录审批和问答回环状态
- 保存事件投递游标和失败重试信息

## 长连接约束

### 企业自建应用

方案默认基于飞书长连接能力，要求使用企业自建应用。

### 新版卡片交互

需要统一采用新版卡片交互协议。旧版消息卡片回传不纳入本方案。

### 3 秒确认窗口

长连接收到消息或卡片动作时，不应同步执行 OpenCode 推理或复杂数据库事务。推荐模式是：

1. 解析和校验
2. 写幂等记录
3. 投递内部队列
4. 立即确认

### 单活消费

长连接模式下，同一应用多连接会发生随机分流。因此首版推荐单活消费：

- 一个应用只保留一个活跃连接进程
- 如果未来做多实例，必须增加 leader 选举或分片机制

## 推荐部署方式

### 方案 A: NAT 单机部署

适合本地开发和最初落地。

- Gateway Runtime 与 OpenCode Server 运行在同一台 NAT 机器
- 无公网入口
- 机器主动连接飞书长连接和飞书消息 API
- OpenCode 仅本机或内网开放

### 方案 B: NAT 网关 + 内网 OpenCode

适合办公室网络或内网机器房。

- Gateway Runtime 部署在有公网出站能力的 NAT 机器上
- OpenCode Server 部署在同网段或可达内网
- Gateway 通过 Basic Auth 调 OpenCode

### 方案 C: 集中化 Gateway，分 repo OpenCode

适合后续多仓、多团队扩展。

- 一个集中化 Gateway 维护飞书长连接
- Gateway 内部维护 repo/workspace 路由表
- 每个 repo 对应独立 OpenCode 实例或 workspace
- `/global/event` 可作为跨实例聚合入口

## 为什么不采用公网 webhook

不采用公网 webhook 的原因有三点：

- 当前部署前提没有公网 IP 和域名
- 长连接已经能覆盖飞书消息接收和新版卡片交互
- 开发和部署都更轻，不需要额外维护公网入口和证书

## 为什么不直接驱动 TUI

不推荐把飞书 IMUI 构建在 `/tui/*` 控制接口上，原因如下：

- TUI 接口更像 UI 驱动层，不是面向机器人接入的稳定领域接口
- IM 更需要 `session`, `permission`, `question`, `event` 这些后端协议
- 异步执行、卡片审批和事件桥更贴近 `prompt_async + SSE` 模型
