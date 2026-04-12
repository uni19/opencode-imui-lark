# 09 Junior Engineer Playbook

## 目标

这份文档给“接手后续开发的初级工程师”使用。

目标不是让新人自行重新设计架构，而是让他在当前基础上，按既定主线把项目推进到“完善、可发布”的状态。

## 一句话结论

可以交给初级工程师继续推进，但有前提：

- 可以承担“按清单逐项实现”的执行工作
- 不适合独立做架构重设计或协议语义改写
- 关键改动仍需要一位熟悉当前状态机的工程师做 review

换句话说：

- `Yes`: 可以交接执行
- `No`: 不能完全放手不看

## 当前工程状态快照

截至目前，项目已经不是方案草稿，而是一个可联调、可跑主链的服务。

### 已经具备的能力

- 飞书 `long_conn` 接入可用
- `stdin` 本地联调链路可用
- OpenCode `prompt` + 事件桥可用
- 私聊、群聊 `@bot`、thread 路由可用
- `session / repo / workspace / model` 基础命令可用
- OpenCode slash 桥接可用
- 权限审批、问题追问、附件等待说明主链可用
- 图片、文件、`post` 富文本、多图、图文混排可进入 OpenCode
- SQLite 持久化已接入运行链路
- 队列、出站消息、附件缓存、pending attachment、连接状态都已落盘
- 长耗时任务已有 watchdog、状态探测、连接恢复提示
- 连接抖动、boot 恢复、ready 后恢复、watchdog 未知状态提示已初步统一

### 当前质量基线

- `bun test` 通过，当前为 `97` 条通过
- `bun run typecheck` 通过
- 测试文件共 `16` 个
- 方案文档、交互文档、模块文档都已经落盘

### 当前最大的风险

- 核心运行状态机仍集中在 `src/app/boot.ts`
- 纯文案、状态展示、错误映射 helper 已开始拆到 `src/app/text.ts`，交接风险比之前低了一层
- `boot.ts` 当前已从约 `3600+` 行降到约 `3200+` 行，但仍是最需要谨慎修改的核心文件
- 但恢复、收尾、连接提示、等待态恢复等主链逻辑仍主要在 `boot.ts`
- 这意味着：
  - 新人可以继续在现有边界内做“小步修改”
  - 但不适合把 `boot.ts` 当成“顺手重构”的对象

## 是否适合交给初级工程师

## 结论

适合，但必须采用“任务包 + 明确边界 + 强制回归”的方式。

## 可以交给初级工程师的工作

- 按既定优先级补功能
- 按既定语义补测试
- 补错误映射和用户提示
- 补飞书实测 case 和发布文档
- 在已有模式内补 `recover / resume / sweep / probe` 的边角
- 在已有命令体系内补 `session / model / repo / workspace` 的体验
- 在已有多模态输入链路上继续收紧回复质量

## 不建议让初级工程师独立拍板的工作

- 改 task 状态机的核心语义
- 新增或重命名核心状态值
- 重做持久化模型
- 重做飞书交互协议
- 大规模拆分或重构 `src/app/boot.ts`
- 修改会影响历史数据兼容性的 SQLite schema
- 变更 OpenCode 协议使用方式

## 必须升级给资深工程师 review 的改动

- `src/contracts.ts`
- `src/storage/db.ts`
- `src/app/boot.ts` 中的状态流转逻辑
- `src/opencode/event.ts` 中的事件推进逻辑
- `src/feishu/conn.ts` 中的连接恢复逻辑
- 任何新增数据库表、修改表结构、修改落盘语义的改动

## 初级工程师工作规则

### 规则 1：每次只做一个任务包

不要同时做“恢复 + 多模态 + 命令体验 + 发布文档”。

一轮只解决一个主题，例如：

- 只做“重启后的 active task 恢复”
- 只做“错误映射和失败提示”
- 只做“`/model` 和 `/session` 飞书实测补齐”

### 规则 2：先补测试，再改代码

凡是改下面这些模块，必须先在对应测试文件里补一个失败用例：

- `recover()` -> `test/recover.test.ts`
- `resume()` / `on_conn()` -> `test/boot.test.ts`
- `sweep()` -> `test/watch.test.ts`
- `probe()` -> `test/probe.test.ts`
- `on_event()` -> `test/event.test.ts`
- 回复提纯 / 最终结果抓取 -> `test/opencode-client.test.ts`
- 多轮消息主链 -> `test/message-flow.test.ts`

### 规则 3：不要顺手重构

如果任务目标是补一个恢复分支，就只补恢复分支。

不要在同一轮里顺手：

- 重命名一批 helper
- 调整大量文件结构
- 把 `boot.ts` 拆成很多文件
- 改 Render 契约

当前目标是“发布前收口”，不是“代码美化工程”。

### 规则 4：每轮必须做最小验证

每个任务包完成后，至少执行：

```bash
bun test
bun run typecheck
```

如果改到了飞书交互、恢复或附件主链，还要补一条手工验证记录。

### 规则 5：保留现有用户语义

目前已经收口的语义不要随意改动：

- 权限审批只用数字序号 `1 / 2 / 3`
- 问题选项优先用数字序号
- 附件-only 先进入等待说明
- 群聊首条消息需要 `@bot`
- 连接抖动提示要避免刷屏

如果要改这些语义，必须先和资深工程师确认。

## 发布前的判断标准

只有同时满足下面几类条件，才算接近“可发布”：

### A. 主链稳定

- 文本对话可用
- 群聊 `@bot` 可用
- 会话切换和目录绑定可用
- 附件输入可用
- 权限审批和问题追问可用
- 长耗时任务最终能收尾，不长期卡住

### B. 恢复稳定

- 连接抖动后能继续同步
- 进程重启后，活跃任务不会长期悬空
- 迟到事件不会污染已完成任务
- watchdog、recover、resume、probe 语义一致

### C. 用户反馈明确

- 错误提示可读
- 恢复提示可读
- 长耗时任务有明确“处理中 / 恢复中 / 失败 / 完成”状态

### D. 文档完整

- README 可独立指导部署
- `.env.example` 可用
- 关键命令说明完整
- 有发布前自测清单，例如 `docs/10-release-checklist.md`

## 当前推荐开发顺序

下面是建议初级工程师按顺序执行的任务包。

顺序不要乱。

---

## Task Pack 1：重启后的 active task 恢复

### 优先级

最高。

### 背景

连接抖动、boot 首次恢复、ready 后恢复、watchdog 未知状态提示，这条线已经基本打通。

还没完全收口的是：

- 进程重启后，`queued / acked / running` 任务是否能稳定续跑或明确失败
- boot 首次 `recover()`、后续 `on_conn(opencode ready)`、watchdog `sweep()` 三者之间是否还存在重复提示或状态不一致

### 重点文件

- `src/app/boot.ts`
- `test/recover.test.ts`
- `test/boot.test.ts`
- `test/watch.test.ts`
- `test/probe.test.ts`

### 实施步骤

1. 先读 `recover()`、`resume()`、`sweep()`、`probe()`、`finish()`
2. 先补失败用例，再改代码
3. 只修“恢复衔接”问题，不做结构重构
4. 确保用户最终只看到一条连续的恢复/处理中卡片，不被多套文案来回覆盖

### 需要补的测试

- boot 后 `queued` 任务在 OpenCode ready 后被重新确认并推进
- boot 后 `running` 任务在 OpenCode ready 后自动收尾
- boot 后 `running` 任务在状态探测持续失败时，watchdog 不会误判结束
- 同一个任务在 `recover -> resume -> sweep` 多段链路里不会重复失败或重复完成

### 完成标准

- `queued / acked / running` 的 boot 恢复主链有自动化回归
- 用户侧文案没有明显冲突
- `bun test` / `bun run typecheck` 通过

### 遇到这些情况要升级

- 需要新增 task 状态
- 需要修改 `summary()`、`active()`、`label()` 这类全局状态 helper
- 需要改动数据库结构

---

## Task Pack 2：队列恢复、迟到事件、幂等继续收紧

### 优先级

高。

### 背景

`queue_job` 落盘、OpenCode 事件基础幂等、迟到事件保护已经有了第一层实现，但还没有完全收口。

### 重点文件

- `src/queue/bus.ts`
- `src/gateway/ingest.ts`
- `src/app/boot.ts`
- `src/opencode/event.ts`
- `src/storage/db.ts`
- `test/queue.test.ts`
- `test/event.test.ts`
- `test/dispatch.test.ts`
- `test/ingest.test.ts`

### 实施步骤

1. 明确“重复入站事件”“重复 OpenCode 事件”“迟到完成事件”“迟到权限事件”四类场景
2. 逐类补测试
3. 只在必要处补幂等 key，不要扩大范围到所有事件
4. 保证“不会重复推进”优先于“尽量显示更多进度”

### 需要补的测试

- 同一条飞书消息重复入队时不重复创建任务
- 同一条 OpenCode idle/error 迟到到达时不污染已完成任务
- 队列恢复后不会重复执行已完成 job
- 同一 req 的问题 / 权限事件 replay 时不会重复打断用户

### 完成标准

- 幂等相关回归变得更完整
- 重放、迟到、重复事件都不会明显破坏用户状态

### 遇到这些情况要升级

- 发现现有 event key 设计根本不够用
- 需要新增持久化字段来承载更复杂幂等信息

---

## Task Pack 3：失败通知与长耗时体验

### 优先级

高。

### 背景

错误映射已经起步，但距离“发布可用”还差最后一段。

现在需要收的是：

- 用户动作建议是否足够明确
- 长耗时任务在“处理中 / 重试中 / 恢复中 / 失败 / 已结束但无结果”之间是否有稳定文案

### 重点文件

- `src/app/boot.ts`
- `src/render/text.ts`
- `src/render/card.ts`
- `test/error.test.ts`
- `test/boot.test.ts`
- `test/watch.test.ts`

### 实施步骤

1. 先梳理现有 `friendly()`、`advice()`、`explain()` 分支
2. 补缺的 provider/network/attachment 错误
3. 统一文案风格：
   - 发生了什么
   - 用户现在该做什么
4. 不要暴露内部实现细节给用户

### 需要补的测试

- 常见 provider 报错
- 更细的网络错误
- patch 失败降级时的用户提示
- 长耗时 stuck 场景的提示分级

### 完成标准

- 用户能看懂错误
- 用户知道下一步该“稍后重试 / 重发上一条 / 重发附件 / /abort”

---

## Task Pack 4：`session / model / repo / workspace` 飞书实链收口

### 优先级

中高。

### 背景

这些命令已经能跑，但“能跑”和“发布可用”还不是一回事。

需要把真实飞书链路下的组合体验补成稳定流程。

### 重点文件

- `src/gateway/cmd.ts`
- `src/gateway/session.ts`
- `src/app/boot.ts`
- `test/cmd.test.ts`
- `test/boot.test.ts`
- `README.md`

### 必做场景

- `/new`
- `/status`
- `/sessions`
- `/session <id>`
- `/repo`
- `/repo --chat`
- `/repo --me`
- `/repo --workspace`
- `/model`
- `/model <provider>/<model>`
- `/model reset`

### 需要补的自动化内容

- 解析测试
- 作用域优先级测试
- 切会话后目录 / workspace / model 展示是否正确

### 需要补的手工验证

- 私聊
- 群聊 thread
- 切会话后继续追问
- 切目录后新会话是否真的切 scope

### 完成标准

- 组合命令在飞书里可预测
- `/status` 返回能解释当前真实上下文

---

## Task Pack 5：多模态质量收口

### 优先级

中高。

### 背景

输入链路已经打通，但“答得像不像一个发布产品”还要继续打磨。

### 重点文件

- `src/feishu/map.ts`
- `src/app/boot.ts`
- `src/opencode/client.ts`
- `test/map.test.ts`
- `test/message-flow.test.ts`
- `test/opencode-client.test.ts`

### 重点目标

- 图片问答别再漏内部工具过程
- 多附件、多图、图文混排的 prompt 组织更稳
- 附件-only -> 补说明 -> 最终回答的体验更顺

### 需要补的测试

- 多图 + 一句问题
- 文件 + 图片 + 说明
- 只有附件，没有说明，连续补多次附件
- 只有内部文本、只有 summary、只有半成品时的最终回复提纯

### 完成标准

- 常见图片问答不会再把缓存路径或内部过程发给用户
- 多附件场景下模型能更稳定地基于附件回答

---

## Task Pack 6：发布准备

### 优先级

最后一包，但必须做。

### 重点文件

- `README.md`
- `.env.example`
- `.gitignore`
- `docs/06-delivery-plan.md`
- `docs/10-release-checklist.md`
- 新增发布检查文档时放在 `docs/`

### 必做内容

- README 改成“陌生人也能跑起来”
- 明确最小依赖、配置项、启动命令、飞书控制台配置
- 补“发布前手工验证清单”
- 清理显然不该提交的本地数据和噪音
- 确认 `.data/`、日志、缓存不会被错误纳入发布内容

### 建议新增的检查清单

- 环境变量是否齐全
- 私聊是否可用
- 群聊 `@bot` 是否可用
- 权限审批是否可用
- `/status`、`/abort` 是否可用
- 图片 / 文件 / post 富文本是否可用
- 重启后恢复是否至少不悬空

### 完成标准

- 一个不熟悉项目的人能按文档跑起来
- 发布前测试与手工清单完整

## 建议的日常执行模板

每完成一个任务包，都按下面流程执行：

1. 先读相关代码和测试
2. 先写一个失败测试
3. 做最小代码修改
4. 跑：

```bash
bun test
bun run typecheck
```

5. 如果改到飞书真实链路，做一轮手工验证
6. 把结果回写到 `docs/06-delivery-plan.md`

## 手工验证记录模板

建议每个任务包都补一段简短记录：

```md
### 2026-04-12 - Task Pack X

- 改动范围：
- 自动化验证：
- 飞书手工验证：
- 结果：
- 遗留问题：
```

## 初级工程师不该踩的坑

### 坑 1：把 `boot.ts` 当成重构练习

不要这样做。

当前阶段最重要的是“行为稳定”，不是“文件看起来更优雅”。

### 坑 2：改了状态机却不补测试

这类改动没有测试，很容易把之前已经收口的恢复链路打回去。

### 坑 3：看到重复文案就直接删逻辑

很多看起来重复的提示，其实是不同恢复阶段的兜底。

删之前先补测试证明“删掉后不会失去语义”。

### 坑 4：拿真实飞书问题去猜

飞书问题优先做“可复现 -> 补自动化 -> 再改代码”。

不要只靠截图猜逻辑。

## 什么时候说明“这个任务包完成了”

只有同时满足以下条件，才算完成：

- 目标功能行为达成
- 自动化测试补上了
- `bun test` 通过
- `bun run typecheck` 通过
- 如果影响飞书真实交互，至少做过一轮手工验证
- `docs/06-delivery-plan.md` 已更新

## 最后结论

当前项目已经到了“可以让初级工程师接着做”的阶段，但方式必须对：

- 不是放手让他自由发挥
- 而是给他这份清单，让他按顺序做
- 每个任务包都保持小步推进
- 所有关键改动都靠测试和 review 托底

只要按这个方式推进，后续工作是可以稳定交接的。
