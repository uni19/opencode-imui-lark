# 06 交付计划

## 文档状态

本文替换旧的“后 MVP 打磨阶段”叙事，改成当前 OMO 迁移的真实分阶段计划。目标不是宣称新模型已经交付，而是把文档、模型、runtime、测试按正确顺序推进到位。

## 目标

本轮交付需要同时达成：

- 一个用户轮次可以对应多个助手 outbound
- `idle` 不再被当成直接完成
- IMUI 可以展示多次“完成态”卡片，但必须区分中间态与最终态
- 回复消息始终能对应到 originating user turn
- 后台 session 切换、deferred wait replay、attachment-only hold、reconnect/watch throttling、Feishu reply threading 都继续成立
- 新普通 prompt 可以在旧 task 后台继续执行时创建新的前台 turn

## 固定约束

- `Task` 继续存在，但重新定义为 originating user turn
- 新增 `assistant_outbound` 作为 1:N 子账本
- `task.outbound_id + outbound_message` 暂时保留为 visible-slot compat pointer
- `pending_attachment` 从 `session_id` 迁到 `task_id`
- 多个开放 user turn 不能共享一个 OpenCode `session_id`
- 同一前台 thread 同时只允许一个可见 wait
- `bun test` 与 `tsc --noEmit` 是最终回归门槛

## 非目标

- 不承诺“同一 thread 同时可见多个 waiting 卡片”
- 不把 Feishu API 改造成批量多消息接口
- 不先删兼容表再做迁移
- 不把当前文档写成“功能已全部上线”的假状态

## Phase 1：文档冻结

目标文件：

- `docs/02-architecture.md`
- `docs/03-session-and-message-model.md`
- `docs/04-api-contracts.md`
- `docs/05-interaction-flows.md`
- `docs/06-delivery-plan.md`
- `docs/15-background-session-switch.md`

产出：

- 明确定义 `Task = originating turn`
- 明确定义 `assistant_outbound = child ledger`
- 明确 `idle != terminal`
- 明确 fresh-session rotation、task-owned pending、reply anchor、兼容窗口

验收：

- 核心文档里不再出现“idle 就是完成”“一个 task 只有一个 outbound”“/new 先取消旧运行”的旧语义

## Phase 2：合约 / Schema / Store 兼容层

目标文件：

- `src/contracts.ts`
- `src/storage/admin.ts`
- `src/storage/db.ts`
- `src/gateway/task.ts`
- `test/sqlite.test.ts`

关键改动：

- 新增 `AssistantOutbound` 类型与 store API
- schema bump，引入 `assistant_outbound(...)`
- 新增 task-owned `pending_attachment_task(...)`
- 保留 `outbound_message(task_id PK)` 作为 compat mirror 并 dual-write
- 老 `pending_attachment(session_id)` 采用 lazy migration

验收：

- 一个 task 能持久化多个 outbounds
- `store.get_outbound(task_id)` 仍然返回 visible slot
- task-owned pending 持久化成立
- 老库升级后仍能打开并恢复兼容路径

## Phase 3：用 child outbounds 替换 synthetic wait tasks

目标文件：

- `src/app/boot.ts`
- `test/event.test.ts`
- `test/progress.test.ts`
- `test/dispatch.test.ts`
- `test/boot.test.ts`

关键改动：

- 去掉 later permission/question 时的 task 克隆
- wait 历史挂在同一个 task 的 `assistant_outbound` 下
- 前台只展示队头 wait
- 后台 wait 只记账，不立刻显示

验收：

- repeated `permission.asked` / `question.asked` 不再新增 task 行
- 同一前台 thread 仍然只有一个可见 wait
- progress 与 wait 的可见性关系保持正确

## Phase 4：multi-outbound delivery + terminal idempotency

目标文件：

- `src/opencode/client.ts`
- `src/app/boot.ts`
- `test/boot.test.ts`
- `test/event.test.ts`
- `test/dispatch.test.ts`
- `test/probe.test.ts`

关键改动：

- runtime 不再把所有助手输出压成一条 final text
- `publish / deliver / patch` 按 child outbound 工作
- `session.status=idle` 改成 checkpoint/reconciliation
- repeated terminal 尝试变成 no-op

验收：

- 同一个 task 可以产生多条 outbound
- repeated idle with same `result_hash` 是幂等 no-op
- patch fallback 不会抹掉 outbound 历史

## Phase 5：supersession、task-owned attachment holds、recover/watch 硬化

目标文件：

- `src/app/boot.ts`
- `src/gateway/session.ts`（只在确实需要 helper 时）
- `test/message-flow.test.ts`
- `test/recover.test.ts`
- `test/watch.test.ts`
- `test/boot.test.ts`

关键改动：

- pending attachments 全部转成 `task_id` 寻址
- `/abort`、`/repo` 等清理 pending 时按 `task_id` 做
- 新普通 prompt 遇到 live non-waiting task 时，`route.reset(...)` 到 fresh session
- `recover / resume / sweep / probe` 不再重新关闭已经 terminal 的 task
- delayed wait replay 只在 session 回前台时发生

验收：

- `/new` 与 superseding prompt 不再中止旧 task，但旧 task 仍可后台完成
- background wait 直到 replay 才显示
- 背景 final/error 仍然回到 originating reply anchor

## Phase 6：文档 / 运维同步 + full regression gate

目标文件：

- `README.md`
- `docs/06-delivery-plan.md`
- `docs/09-junior-engineer-playbook.md`
- `docs/10-release-checklist.md`
- 以及任何被实现细节反证后需要修正的核心设计文档

关键改动：

- 去掉 README 和运维文档里关于旧 session 语义的陈述
- 增加 intermediate/final、supersession、background replay、terminal no-op 的手工回归用例
- 确保发布前文档与真实行为一致

验收：

- `bun test`
- `tsc --noEmit`
- 通过一次真实 Feishu 手工回归

## 最终必须成立的回归不变量

- 一次用户轮次只创建一个 task
- 一个 task 可以拥有多个 `assistant_outbound`
- `store.get_outbound(task_id)` 在兼容窗口里仍然返回 visible slot
- `pending_attachment` 的归属是 `task_id`
- 每个 outbound 都保留 originating inbound / message correlation
- `session.status=idle` 单独出现时不完成 task
- 一个 task 最多只有一个 terminal closure
- 后台 wait 延迟显示，切回时 replay
- 新普通 prompt 遇到 live non-waiting task 时必须 fresh-session rotation
- patch fallback 仍可用，且不会擦掉 outbound 历史

## 验证策略

- 每个 phase 都先补对应测试，再让实现过测试
- 最终全量验证使用：

```bash
bun test
tsc --noEmit
```

- 代码全绿后，再进入真实 Feishu 联调验收
