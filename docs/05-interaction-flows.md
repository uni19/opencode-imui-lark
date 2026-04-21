# 05 交互流

## 文档状态

本文描述 OMO 目标交互流。当前代码已经有后台 session 切换、wait replay、progress flush、patch fallback 等基础，但仍然带着“单 task 单可见消息、idle 直接完成”的旧语义。下面是需要收敛到的目标流程。

## 流程 1：普通 OMO 轮次

```text
User -> Feishu
Feishu -> Long Connection Client
Long Connection Client -> Gateway Queue
Gateway Queue -> SessionRouter
SessionRouter -> resolve/reset session
Gateway Worker -> create Task
Gateway Worker -> OpenCode session.prompt_async
Gateway Worker -> Feishu ack
OpenCode -> message.* / tool progress
Gateway -> assistant_outbound(progress)
Gateway -> patch current visible slot
OpenCode -> session.status=idle
Gateway -> reconcile(result_hash, unresolved waits)
Gateway -> no-op | intermediate card | final card
```

### 关键点

- `idle` 是 checkpoint，不是直接完成
- 同一个 task 可以经历多次 `idle -> reconcile`
- 如果 `result_hash` 没变，重复 idle 必须是 no-op
- 如果有新的用户可见阶段性结果，但 task 仍非终态，可以发一张“中间完成态”卡片
- 只有当没有 unresolved wait，且 reconciliation 找到真实 final candidate 时，才发送“最终完成态”卡片并关闭 task

## 流程 2：权限 / 追问都挂在同一个 task 下

```text
OpenCode -> permission.asked / question.asked
Gateway -> append assistant_outbound(wait)
Gateway -> if foreground && head wait: visible card
Gateway -> else: deferred only
User -> reply 1 / 2 / 3 or free text
Gateway -> bind reply to foreground task head wait
Gateway -> OpenCode permission.reply / question.reply
OpenCode -> continue execution on same task
```

### 关键点

- 不再为后续 `permission.asked` / `question.asked` 克隆 task
- wait 历史属于同一个 task 的 child outbounds
- 同一前台 thread 同时只展示一个 head wait
- 后续 wait 可以先在后台排队，等前一个 wait 解决后再 visible
- 自由文本只能绑定前台 task 的 head unresolved wait

## 流程 3：附件-only hold

```text
User -> send files/images only
Gateway -> create Task
Gateway -> save task-owned pending_attachment
Gateway -> visible prompt: 请补一条文字说明
User -> send follow-up text
Gateway -> merge text + pending assets
Gateway -> OpenCode session.prompt_async
```

### 关键点

- 附件等待的归属是 `task_id`，不是 `session_id`
- `/new`、`/session`、recover 都不能把这个 hold 丢掉
- 如果用户切走，这个 wait 进入 deferred 状态；切回时再 replay

## 流程 4：后台 session 切换与 wait replay

```text
User -> /session <old> or /new
Gateway -> switch/reset foreground session pointer
Old live task -> continue in background
Background task -> permission.asked / question.asked / waiting_attachment
Gateway -> append deferred assistant_outbound only
User -> switch back to old session
Gateway -> replay head unresolved wait
```

### 关键点

- `/session` 与 `/new` 不再默认中止旧 live task
- 后台 wait 只落账，不抢当前前台 thread
- replay 的目标是“当前队头 unresolved wait”，不是把旧历史全部重贴一遍
- 背景 task 即使失去前台 session 映射，仍然保留自己的 reply anchor

## 流程 5：superseding prompt 与 fresh-session rotation

```text
Foreground task A -> queued/acked/running
User -> send a new normal prompt
Gateway -> SessionSvc.reset(...)
Gateway -> create fresh OpenCode session B
Gateway -> create task B on session B
Task A -> mark superseded_by_task_id = B
Task A -> continue in background
```

### 关键点

- 新普通 prompt 不能和旧 live nonterminal task 共享同一个 OpenCode session
- 这里的 rotation 是 thread 前台视角的切换，不是取消旧任务
- task A 完成后仍然 reply 到自己的 originating message，而不是劫持 task B 的 thread 前台槽位

## 流程 6：用户中止与终态幂等

```text
User -> /abort
Gateway -> abort current foreground session/task
OpenCode -> session.error / idle / abort completion
Gateway -> close terminal once
Late idle/error -> ignored
```

### 关键点

- `/abort` 只针对当前前台 live task
- 如果 task 已经 terminal，重复 `/abort` 只能给用户提示，不应重写状态
- `session.error`、late idle、recover 补偿都必须经过 terminal idempotency 检查
- abort 时要按 `task_id` 清理 pending attachment

## 流程 7：重连、恢复与 watchdog

```text
Message conn / OpenCode SSE -> reconnecting
Gateway -> throttle visible status updates
Gateway -> recover/resume/sweep/probe
Gateway -> rerun reconciliation on live tasks
Gateway -> replay waits only for foreground session
```

### 关键点

- reconnect/watch 语义继续保留，但不能再把 `idle` 直接当终态
- recover/resume/sweep 不能重新关闭已经 terminal 的 task
- 背景 wait 在恢复链路里仍然保持 deferred，直到对应 session 回到前台

## 渲染与节流规则

- progress 仍然按 1~2 秒窗口节流 patch
- 工具状态变化可以更快更新，但不能刷屏
- patch 失败时允许退化为新 reply / 新 message
- 这种退化必须追加新的 child outbound，并推进 visible slot 指针，而不是覆盖历史
- intermediate 与 final 必须显式区分，至少要告诉用户“还有后台任务”还是“已经最终完成”

## 必须保住的交互不变量

- 一次用户轮次只对应一个 task
- 一个 task 可以拥有多个 `assistant_outbound`
- 同一前台 thread 只展示一个可见 wait
- 背景 wait 延迟显示，切回时 replay
- 中间完成态与最终完成态必须区分
- 背景完成态仍然回复到 originating reply anchor
