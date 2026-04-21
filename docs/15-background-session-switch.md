# 15 后台会话切换

## 文档状态

本文重写旧的 background-session-switch 设计。旧文档里的“无 schema 变更、只靠 session 前后台判断即可达成目标”不再是目标方案。新的目标以 `Task + assistant_outbound + task-owned pending_attachment` 为中心。

## 目标

让 IMUI 在切换会话时：

- 不再默认中止当前 live task
- 允许旧 task 在后台继续执行
- 把需要用户参与的 wait 事件延迟到切回对应 session 时再显示
- 让后台完成态仍然回复到原始用户消息链路

## 术语

### 前台 session

当前 thread 绑定到的 OpenCode session，也就是当前用户继续输入时默认命中的 session。

### 后台 task

仍然活跃，但它所属的 `task.session_id` 已经不再是当前 thread 的 foreground session。

### deferred wait outbound

已经被记录到 `assistant_outbound`，但当前不应该立刻显示到 Feishu thread 的 wait 记录。典型来源是后台 `permission.asked`、`question.asked`、`waiting_attachment`。

### reply anchor

task 对应的 originating inbound message。后台完成、后台失败、patch fallback、recover 回帖都必须回到这个 anchor，而不是劫持当前前台 session。

### superseding prompt

用户在旧 task 仍 live 且非等待态时，又发起一个新的普通 prompt。它必须创建新的前台 task，并把旧 task 留在后台继续跑。

## 核心规则

### 1. 切 session 不 abort 旧 task

- `/session <session_id>` 只切 foreground session pointer
- `/new` 只创建新的 foreground session
- 旧 task 继续在旧 session 里后台运行

### 2. 后台 wait 只追加 deferred assistant_outbound

后台 task 收到：

- `permission.asked`
- `question.asked`
- `waiting_attachment`

时，只能：

- 更新 task 当前可见 head wait 元信息
- 追加 `assistant_outbound(action="deferred")`
- 不主动在当前前台 thread 里弹卡

### 3. replay 时只显示当前队头 unresolved wait

切回 session 后，不是把历史 wait 全部重新贴一遍，而是：

- 找到这个 task 当前 head unresolved wait
- 只把这一个 wait replay 到前台
- 其余 wait 继续保留在账本里

### 4. `pending_attachment` 必须是 task-owned

attachment-only hold 在后台切换里最容易串线。目标模型要求：

- pending 按 `task_id` 保存
- `/new` 和 `/session` 不能因为切前台就 drop 它
- 只有 task 真正完成、失败或 abort 时，才允许清理

### 5. 背景完成态必须回复到原始 reply anchor

后台 task 完成时，即使当前 thread 已经切到别的前台 session，也必须：

- reply 到自己的 `reply_anchor_message_id`
- 保留自己的 outbound 历史
- 不覆盖当前前台 task 的 visible slot

### 6. 新普通 prompt 遇到 live 非等待 task 时，必须 fresh-session rotation

这不是“后台切换”的额外功能，而是它能成立的前提：

- 一个 OpenCode session 同时最多只服务一个开放 user turn
- 新 prompt 必须 `SessionSvc.reset(...)`
- 旧 task 进入后台继续跑，可选记录 `superseded_by_task_id`

### 7. 同一前台 thread 同时只展示一个可见 wait

这是 IMUI 的产品边界，不因为 OMO 而放弃：

- 不承诺并列显示多个 wait 卡片
- 不允许后台 wait 抢前台 thread
- `/status`、`/sessions` 可以增强可见性，但不是把后台 wait 全部前台化

## 运行时流程

### 1. `/session <session_id>`

目标行为：

- 允许切换，即使旧前台还有 live task
- 旧前台 task 不自动 abort
- 新 foreground session 如果存在 unresolved head wait，则立即 replay

### 2. `/new`

目标行为：

- 不再“先取消旧任务再新建”
- 直接创建新的 OpenCode session 并绑定为 foreground
- 旧 task 留在后台继续执行
- 如果旧 task 是 `waiting_attachment`，pending 仍然保留

### 3. 后台 `permission.asked` / `question.asked`

目标行为：

- 追加 deferred wait outbound
- 更新 task 当前 head wait 元数据
- 不在当前前台 thread 里立刻 patch 卡片

### 4. 后台 `waiting_attachment`

目标行为：

- 把附件挂到 `task_id`
- 记为 deferred wait
- 用户切回该 session 前，不主动提醒“请补一句说明”

### 5. 切回 session 时 replay

replay 的判断顺序：

1. task 是否已经 terminal
2. 是否还有 unresolved head wait
3. 当前 session 是否回到前台

只有三者满足前两项之一且当前已回前台时，才允许显示 wait。

### 6. recover / resume / sweep / probe

目标行为：

- 重连后重新做 reconciliation
- 已 terminal task 不再被 late idle/error 二次收口
- 后台 wait 仍保持 deferred，直到对应 session 回到前台
- background final/error 仍然按 reply anchor 回帖

## 实现落点

### `src/gateway/session.ts`

- `resolve()`：前台 session 寻址
- `reset()`：fresh-session rotation
- `switch()`：切回旧 session 并触发 wait replay

### `src/app/boot.ts`

关键点：

- `foreground(...)`
- `dest(...)`
- `replay_waiting(...)`
- `on_event(...)`
- `on_msg(...)`
- `recover / resume / sweep / probe`

旧的“session-only/no-schema-change”处理方式应逐步退场，改成 task + outbound ledger 驱动。

### `src/storage/*`

- `assistant_outbound` 持久化
- task-owned pending attachment
- visible slot compat mirror

## 测试要求

至少要覆盖：

- `test/boot.test.ts`
- `test/event.test.ts`
- `test/message-flow.test.ts`
- `test/recover.test.ts`
- `test/watch.test.ts`
- `test/dispatch.test.ts`
- `test/progress.test.ts`
- `test/sqlite.test.ts`

重点断言：

- `/new` 与 `/session` 不再默认中止旧 live task
- 后台 wait 直到 replay 才可见
- `pending_attachment` 按 `task_id` 存活
- background final/error 仍然回复到原始 reply anchor
- recovery 不会把已 terminal task 再次关闭

## 非目标与风险

### 非目标

- 不引入 task 级 CLI 寻址（例如 `/abort <task_id>`）
- 不承诺同一 thread 并列展示多个 visible waits
- 不把后台结果完全隔离到新的 Feishu thread

### 风险

- 背景结果仍然会出现在共享 thread 中；这不是 bug，只要 reply lineage 正确、wait 不抢前台即可
- 真正复杂的点不在“能不能切 session”，而在 terminal idempotency、reply anchor、pending 归属和 recover 一致性
