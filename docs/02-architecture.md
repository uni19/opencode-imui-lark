# 02 架构

## 文档状态

本文定义 OMO 目标架构和迁移约束，不代表仓库已经全部实现。当前代码仍保留单可见出站槽位、session 级 `pending_attachment`、以及等待态 task 克隆等兼容实现；本文件描述的是接下来文档与代码需要收敛到的目标语义。

## 总览

整体结构继续保持“飞书长连接客户端 + Gateway Runtime + OpenCode Runtime”的三层拆分，但交互模型从“一个 task 对应一个 outbound，`idle` 直接收口”切换到“Task 根记录 + `assistant_outbound` 子账本 + 前台线程可见槽位”。

```text
Feishu User
   |
   v
Feishu Open Platform
   <-> Long Connection Client
         |- message events
         |- card actions
         |- fast ack
         v
Gateway Runtime
   |- inbound normalize / dedupe
   |- foreground thread router
   |- task coordinator
   |- OMO reconciler
   |- wait visibility controller
   |- delivery / patch renderer
   |- recovery / watchdog / throttling
   v
Storage
   |- im_session
   |- task
   |- assistant_outbound   (target)
   |- outbound_message     (compat mirror)
   |- pending_attachment   (target: task-owned)
   |- seen_event / queue_job / conn_state
   v
OpenCode Server
   |- session.create
   |- session.prompt_async
   |- permission.reply
   |- question.reply / reject
   |- session.status / message.* / session.error
```

## 核心原则

### 1. Task 是用户原始轮次

Task 定义为一次 originating user turn，也就是真正的一次用户请求入口。一个 task 从创建到终态都保持同一个身份，不再因为 `permission.asked`、`question.asked`、`waiting_attachment` 被克隆成新的 task。

### 2. `assistant_outbound` 是助手发言账本

每个 task 拥有 1:N 的 `assistant_outbound` 子记录，记录 `ack`、`progress`、`approval`、`question`、`intermediate`、`final`、`error` 等所有助手侧发言。前台只会暴露一个当前可 patch 的可见槽位，但账本必须保留完整历史和幂等信息。

### 3. `session.status=idle` 只是检查点

OpenCode 原始 `idle` 只表示 session 当前不忙。它本身不是终态，也不能直接等价为“这一轮 finished”。

任务真正收口要同时满足两件事：

1. reconciliation 找到一个真实的新 final candidate
2. 当前 task 不存在 unresolved wait

只收到 `idle` 而没有新 final，或者还有 wait 未解决，都只能视为非终态检查点。

### 4. 一个 task 可以发 0..N 条非终态消息，但终态最多一次

同一个 task 在生命周期内可以反复发：

- `ack`
- `progress`
- `approval`
- `question`
- `intermediate`

但终态只允许一次：

- `final`
- `error`

一个 task 最多只有一个 terminal closure。后续再来的 terminal 尝试必须被忽略或只记录幂等命中，不能二次收口。

### 5. 同一前台 thread 同时只展示一个可见等待交互

产品约束不变：

- 同一前台 Feishu thread 同时只展示一个 waiting interaction
- 后台 wait 保持隐藏，直到用户切回对应 session 再 replay
- reconnect/watch 的状态提示仍然要节流，不能刷屏

### 6. 多个未收口用户轮次不能共享一个 OpenCode session

如果当前前台 task 仍是 non-terminal，而用户又发来新的普通 prompt，这个 prompt 不能继续复用旧 session。线程必须旋转到 fresh OpenCode session，旧 task 留在旧 session 里后台继续跑。

当前代码已经有 `SessionSvc.reset/switch` 这条 seam，目标设计沿用这条 seam 做 fresh-session rotation，而不是让多个开放任务共用一个 session。

### 7. 所有 Feishu 回帖都绑定不可变 reply anchor

每个 task 都有 originating inbound message。所有 `assistant_outbound` 都必须关联这个 immutable reply anchor，这样即使线程已经切到新的前台 session，旧 task 在后台完成时仍然会回到正确的 Feishu 消息链路。

### 8. 兼容窗口保留单可见槽位

现有实现里：

- `task.outbound_id` 保存当前可 patch 的 Feishu 消息 ID
- `outbound_message(task_id PK)` 保存这个槽位的镜像 payload

引入 `assistant_outbound` 后，这两处字段暂时继续保留，作为“当前可见 patch 槽位”的 pointer/mirror。它们不是完整历史，也不是目标模型的最终权威账本。

### 9. 附件等待改成 task-owned

当前 `pending_attachment` 仍按 `session_id` 挂靠。目标模型改为 task-owned，这样 attachment-only hold 在 session 旋转、后台继续执行、恢复 replay 时都不会串到别的 task。

## 模块职责

### Feishu Connection Manager

- 保持长连接
- 快速 ack
- 标准化消息事件和卡片动作
- 不在回调线程里做 OpenCode 推理

### Session Router

- 维护 `thread -> foreground session` 映射
- 判定一条入站消息是“回复当前 wait”还是“创建新的用户轮次”
- 当新 prompt supersede 旧 live task 时，创建 fresh session 并切前台映射

### Task Coordinator

- 为每个 originating user turn 精确创建一个 task
- 在同一 task 上推进 `running -> waiting_* -> running`
- 不再为后续 approval/question 克隆 task
- 持有 task-owned pending attachments

### OMO Reconciler

- 消费 OpenCode `message.*`、`permission.*`、`question.*`、`session.status`、`session.error`
- 追加 `assistant_outbound`
- 维护 wait 队列
- 把 `idle` 当 checkpoint，而不是当 `final`
- 只在发现真实 terminal candidate 时关闭 task

### Wait Visibility Controller

- 同一前台 thread 只暴露一个 waiting interaction
- 后台 wait 只落账，不立刻发卡
- 用户切回 session 后 replay 对应 wait

### Delivery / Renderer

- 用 `assistant_outbound` 作为目标账本
- 用 `task.outbound_id + outbound_message` 维护当前 patch 槽位兼容
- 区分 reply、patch、隐藏等待、后台 final 回帖

### Recovery / Watchdog

- 保留现有 reconnect/watch throttling
- 重连后重新做 reconciliation
- replay 前台 wait，保持后台 wait 隐藏
- 对 terminal outbound 做幂等保护

## 当前实现与目标差距

当前仓库已经有这些可复用基础：

- `prompt_async + SSE/event`
- `SessionSvc.reset/switch`
- `task.outbound_id` 与 `outbound_message`
- 以 originating inbound 为 reply anchor 的 Feishu reply
- 后台 session 切换和 wait replay 的第一版
- reconnect/watchdog 节流

但还没有完整交付：

- `assistant_outbound` 1:N 账本
- task-owned `pending_attachment`
- 同 task 的 wait 队列
- `idle` checkpoint 和 terminal reconciliation 的正式语义
- superseding prompt 自动 fresh-session rotation
