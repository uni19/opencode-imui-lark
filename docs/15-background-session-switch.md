# 15 Background Session Switch

状态：

- 首版已完成代码实现
- 当前已支持“后台继续执行 + 等切回 session 再展示等待态”
- 后续剩余工作主要是 `/status` 可见性增强和真实飞书手工回归

## 目标

让 IMUI 在切换会话时，不再默认中止当前 live task，而是允许任务继续在后台执行。

这里的“后台执行”不是完全照搬 OpenCode TUI 的多会话体验，而是一个更适合飞书 IM 场景的折中版本：

- `queued / acked / running` 任务可以继续在后台执行
- 后台任务如果进入 `waiting_permission / waiting_question / waiting_attachment`，先只在后端记录状态
- 等用户切回该 session，这个等待态才重新显示到当前 thread

## 为什么适合 IMUI

TUI 有明确的 session 面板，可以同时看到多个会话的状态。

飞书 IM 不一样：

- 同一个 thread 是单条消息流
- 多个 session 的交互如果同时往前台弹卡片，用户很容易混淆
- 审批、追问、补附件都需要后续输入，天然更适合“当前前台会话独占”

所以 IMUI 更适合这套语义：

- 后台任务可以继续跑
- 但需要用户继续参与的等待态，不主动打断当前前台 session

## 非目标

这次设计不追求：

- 在同一 thread 中同时活跃地操作多个等待态任务
- 给后台任务增加独立的审批 thread
- 支持 `/abort <task_id>`、`/status <task_id>` 这类精细 task 寻址
- 重做现有 task 状态机或 OpenCode 协议语义

## 术语

### 前台 session

当前 thread 映射到的 OpenCode session，也就是：

- `store.get_session({ tenant_id, chat_id, thread_id })`

返回的那一条 `ImSession`

### 后台 task

仍然活跃，但其 `task.session_id` 已经不是当前 thread 的前台 session。

### 延迟显示的等待态

task 已经进入：

- `waiting_permission`
- `waiting_question`
- `waiting_attachment`

但由于该 task 当前在后台，所以不立即向飞书发送等待卡片或提示。

## 设计原则

### 原则 1：不新增核心状态值

首版不改 task 状态机，只保留现有状态：

```text
queued -> acked -> running -> waiting_permission / waiting_question / waiting_attachment -> completed / failed / aborted
```

“前台 / 后台”“是否延迟显示”不作为新的数据库主状态，而是运行时根据“当前 thread 的 session 映射”和 `task.session_id` 动态判断。

### 原则 2：后台任务允许完成，但不抢前台交互

后台任务：

- 可以继续接收进度事件
- 可以继续完成或失败
- 可以继续 patch 自己已有的进度卡 / 结果卡

但如果进入等待态：

- 不主动补发审批卡
- 不主动补发问题卡
- 不主动补发“请补一句说明”

### 原则 3：切回 session 时再恢复等待交互

当用户执行 `/session <session_id>` 切回该 session：

- 如果该 task 仍处于等待态，就立即补发对应等待卡片或提示
- 如果该 task 已经恢复运行或已结束，则按最新状态展示，不再补发旧等待态

### 原则 4：先做会话级切换，不做 task 级切换

这次只支持：

- `/session <session_id>`
- `/new`

语义变化

不扩展：

- `/task`
- `/abort <session>`
- `/status <session>`

避免把范围一下拉大。

## 用户侧行为规则

### 1. `/session <session_id>`

当前行为：

- 如果当前 session 有 live task，则禁止切换

目标行为：

- 允许切换
- 当前 live task 不再自动 `abort`
- 切换完成后，新 session 成为前台
- 如果目标 session 本身有等待态，则立即把等待态重新展示出来

### 2. `/new`

当前行为：

- 如果当前 session 有 live task，则会 `abort`

目标行为：

- 不再自动中止旧 task
- 直接创建新 session 并绑定为当前前台 session
- 原 task 留在后台继续执行

特殊说明：

- 若旧 task 是 `waiting_attachment`，其 `pending_attachment` 也应保留
- 不应因为 `/new` 而 `drop_pending`

### 3. 普通消息

当前前台 session 仍保持单活语义：

- 用户发普通文本，只路由到当前前台 session
- 如果当前前台 session 正在等待问题 / 审批 / 补附件，则优先视为该等待态的回答

后台 session 不会抢占普通消息。

### 4. 后台 task 收到等待态事件

#### 后台 `waiting_permission`

- 更新 `task.status=req/note`
- 不向飞书发审批卡

#### 后台 `waiting_question`

- 更新 `task.status=req/note`
- 不向飞书发问题卡

#### 后台 `waiting_attachment`

- 这是本地消息链路形成的等待态
- 切到后台后保留 `pending_attachment`
- 不主动提示用户补说明

### 5. 切回 session 后

当 `/session <session_id>` 切回旧 session：

- 若最后一个 task 是 `waiting_permission`，补发审批卡
- 若最后一个 task 是 `waiting_question`，补发问题卡
- 若最后一个 task 是 `waiting_attachment`，补发“请补一句说明”
- 若该 task 已经 `running / completed / failed / aborted`，则不补发等待态

### 6. `/sessions` 和 `/status`

为了避免后台等待态完全不可见，建议增强：

- `/sessions`：优先显示本地 task 等待态，而不是只显示远端 `busy/idle`
- `/status`：明确显示当前 session 是否存在后台任务等待你切回处理

这部分不是切换能力的绝对前置条件，但建议作为同一 task pack 一起做。

## 首版实现建议

### 方案选择

首版建议采用：

- `无 schema 变更`
- `尽量少碰持久化模型`
- `以前台 session 映射 + inbound 回落` 做动态判断

这样改造成本明显低于“给 task 新增 foreground/background 字段”。

### 可复用的现有基础

当前代码已经具备下面这些能力：

- task 按 `session_id` 独立落盘
- task 还记录了 `inbound_id`
- `dest(...)` 在 session 映射失效后，仍能靠 `inbound_id` 回到原 thread patch 消息
- `recover / resume / sweep / probe` 已经主要按 task 状态工作，不完全依赖当前 session

所以“后台继续跑”不是从零开始。

### 推荐新增 helper

建议在 `src/app/boot.ts` 中新增两个轻量 helper：

#### `foreground(...)`

输入：

- `store`
- `row: Task`

逻辑：

1. 通过 `row.inbound_id` 找到原始 inbound message
2. 再用 inbound 的 `tenant_id/chat_id/thread_id` 查询当前 thread 绑定的 session
3. 判断 `current?.session_id === row.session_id`

返回：

- `true`：当前前台 task
- `false`：后台 task

#### `replay_waiting(...)`

输入：

- `row`
- `chat_id`
- `render`
- `store/task/feishu`

逻辑：

- 根据 `row.status` 和 `row.note/req` 重建对应等待态消息
- 仅用于切回 session 或恢复前台时补发

支持：

- `waiting_permission`
- `waiting_question`
- `waiting_attachment`

## 代码改动点

### 1. `on_cmd()`

文件：

- `src/app/boot.ts`

改动：

- `/session <id>`：移除“live task 禁止切换”的 guard
- `/new`：移除 live task 时的 `abort()` / `drop_pending()`
- 切换成功后，如果目标 session 的最后任务是等待态，则调用 `replay_waiting(...)`

### 2. `on_event()`

文件：

- `src/app/boot.ts`

改动：

- `permission.asked`
- `question.asked`

在 patch 卡片前先判断 `foreground(row)`：

- 前台：保持现有行为
- 后台：只更新 task 状态与 note，不调用 `patch(...)`

### 3. `on_msg()`

文件：

- `src/app/boot.ts`

改动重点不是普通消息路由，而是等待态回放：

- 用户切回 session 后，后续消息才能继续命中该 session 的等待态分支
- `waiting_attachment` 不再因为 `/new` 或 `/session` 被主动清空

### 4. `recover / resume / sweep`

文件：

- `src/app/boot.ts`

改动：

- 对后台等待态，不要在恢复链路里直接重贴卡片
- 只有当对应 session 回到前台，才通过 `replay_waiting(...)` 显示

否则会出现：

- 用户明明切走了，连接恢复后旧 session 又弹回前台等待卡片

### 5. `sessions()` / `status_text()`

文件：

- `src/app/boot.ts`
- `src/app/text.ts`

改动：

- 让 `/sessions` 和 `/status` 能看到本地等待态
- 至少要能区分：
  - `running`
  - `waiting_permission`
  - `waiting_question`
  - `waiting_attachment`

## 测试清单

### `test/boot.test.ts`

至少补：

- `/session` 切换时，不再中止当前 running task
- `/new` 时，不再中止当前 running task
- 切回 `waiting_permission` session 时，审批卡会重新显示
- 切回 `waiting_question` session 时，问题卡会重新显示
- 切回 `waiting_attachment` session 时，补说明提示会重新显示

### `test/event.test.ts`

至少补：

- 后台 session 收到 `permission.asked` 时，只更新状态，不立即 patch 卡片
- 后台 session 收到 `question.asked` 时，只更新状态，不立即 patch 卡片

### `test/message-flow.test.ts`

至少补：

- `waiting_attachment` session 切到后台后，`pending_attachment` 不丢
- 切回 session 后，用户补一句文本仍能继续执行

### `test/recover.test.ts` / `test/watch.test.ts`

至少补：

- 后台等待态在 `recover / resume / sweep` 中不会被自动重贴
- 切回前台 session 后才会显示等待态

## 风险

### 风险 1：后台 task 的完成消息与前台 task 混在同一 thread

这是接受的设计结果，不视为 bug。

因为用户本来就在同一 thread 中显式切 session，thread 仍然是共享消息流。

本次设计只保证：

- 等待交互不抢当前前台

不保证：

- 后台结果永远不出现在当前 thread

### 风险 2：后台等待态完全不可见

如果不补 `/sessions` 和 `/status` 提示，用户会忘记后台 session 正在等他。

所以建议把“可见性增强”作为同一 task pack 的一部分。

### 风险 3：恢复链路把后台等待态重新弹出来

这是实现时最容易漏的点。

必须统一检查：

- `on_event`
- `resume`
- `recover`
- `sweep`

## 推荐拆分顺序

#### Step 1

只改 `/session` 和 `/new`：

- 不再 `abort`
- 不再 `drop_pending`

先让后台继续跑起来。

#### Step 2

补 `foreground(...)` 和 `replay_waiting(...)`

#### Step 3

补 `permission/question/waiting_attachment` 的后台延迟显示

#### Step 4

补 `/sessions` 与 `/status` 的后台等待态可见性

#### Step 5

补 `recover / resume / sweep` 一致性回归

## 结论

这个方案适合 IMUI，而且比“完全照搬 TUI 多会话交互”更稳。

对当前代码基线来说，改造量属于中等：

- 不是小修
- 但也不需要重做状态机和数据库模型

如果按这里的分步方案推进，是可以交给初级工程师实现、再由资深工程师 review 的。
