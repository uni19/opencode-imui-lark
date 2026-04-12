# 06 Delivery Plan

## 当前实现状态

当前代码已经从“方案骨架”进入了“可联调 MVP”阶段，主链功能已通，下一步重点不再是补大块新能力，而是把稳定性、恢复和用户体验打磨到可持续使用。

### 已完成

- 飞书长连接接入可用
- `stdin` 本地联调链路可用
- OpenCode `prompt_async` 和 `/global/event` 已接通
- 单消息卡片更新链路已接通
- SQLite 持久化已接入运行链路
- `outbound_message`、`attachment`、`pending_attachment` 已真正落盘并被运行链路消费
- 图片、文件、`post` 富文本、多图、图文混排已可进入 OpenCode `parts`
- 附件-only 输入已支持“等待补充说明”
- 权限审批和问题回问主链已接通，当前稳定方案为“卡片展示 + 文本回复”
- 权限审批只用数字序号 `1 / 2 / 3` 进行选择；若直接发送其他文本，则视为“拒绝并附带说明”
- 问题回问在有选项时优先使用数字序号；如问题允许自定义回答，也可直接回复文本
- 群聊 `@bot`、thread 路由、当前会话 / 聊天默认 / 用户默认 repo 绑定已接通
- `workspace` 绑定语义和命令解析已接通
- `session` 和 `model` 的查看 / 切换命令已接通
- IM 原生命令与 OpenCode slash 桥接已接通
- Phase 9 已开始落地：入站消息队列改为持久化 job，进程启动时会回收并重放未完成 job
- 卡片更新链路已补第一层降级：`patch` 失败时会退化为新回复 / 新消息，而不是直接中断更新链路
- 长耗时任务已补第一层 watchdog：长时间无新进展时，会主动提示可用 `/status` / `/abort`
- 长耗时任务 watchdog 已补第二层对账：对长期无事件任务会主动查询 OpenCode 状态，继续同步、自动收尾或明确失败
- 飞书消息长连接的 `reconnecting / ready / error` 已开始接入活跃任务提示，不再完全静默
- OpenCode SSE 已补 `error -> reconnecting` 显式状态推进，异常不再只有后台日志
- `session.status=idle` 但无最终文本输出时，已补完成兜底提示，避免卡在“处理中”
- 常见网络 / 证书 / 超时 / 认证错误已开始统一映射为用户可读提示，不再大面积直接透传原始报错
- OpenCode HTTP 错误已补响应体透传，模型限流、上下文过长、模型不可用、服务异常等分级开始可见
- 附件下载失败已细分到飞书资源错误，并会尽量带上具体附件名
- provider 常见错误模式已开始细分，包括限流、额度不足、模型繁忙等场景
- 连接类提示已补轻量 cooldown，任务刚有新进展时不会再立刻被重复连接提示刷屏
- SQLite store 落盘级集成测试已补：session 映射、任务 / 出站 / 附件 / pending / seen / conn / queue_job 的跨重启 roundtrip 已有回归
- `waiting_permission / waiting_question` 的跨重启恢复分支已补回归
- 迟到事件保护已开始收紧：已完成 / 已失败 / 已中止任务不会再被迟到的权限、错误、完成事件污染状态
- 进度卡片去重已升级为 payload 级比较，不再只按 `text` 判重，`step` 更新不会被误吞
- `waiting_attachment` 恢复已补附件可用性检查：缓存残缺时会明确失败，而不是继续停在等待态
- 带附件的 prompt 已补轻量回答约束：会明确要求模型直接基于附件回答，不要把内部工具调用、缓存路径或系统注入文本当作最终答案
- 带附件的 prompt 已补附件概览和顺序提示，多图 / 多文件场景下会把附件顺序显式告诉模型，帮助理解“这张 / 第 N 个附件 / 这些文件”之类指代
- 最终回复抓取已开始优先选择“最近一个真正有文本输出的 assistant 消息”，降低收尾拿到空壳 assistant 消息的概率
- 最终回复抓取已进一步收紧：会优先选择“已完成且无错误”的 assistant 文本，降低把流式半成品或异常态残留文本误发给飞书的概率
- 最终回复抓取已排除 `summary assistant`，内部 compaction / 总结消息不会再误抢到正常用户答复前面
- 完成链路已开始区分“真的没有文本输出”和“只有内部 / 总结文本被过滤掉”，前者仍按无结果处理，后者会给出更明确的用户提示
- `waiting_attachment` 的用户提示已补“新收到多少 / 当前累计多少”，多轮补图补文件时不会只看到模糊的“又收到附件”
- 已补 `waiting_attachment` 主链回归：附件-only -> 继续补附件 -> 最后补一句说明 -> 合并送入 OpenCode 的多轮流转已有自动化测试
- 已补 `waiting_attachment` 的空白 follow-up、`/abort`、`/new` 收敛回归，等待态不再只靠手工验证
- task 已开始持久化运行 `directory/workspace` scope，`recover / sweep / signal / queue fail` 不再完全依赖当前 session 映射
- 聊天切换到新会话后，旧任务即使失去 session 映射，也能依靠 task scope + 原始 inbound 回落继续收尾或报错
- OpenCode 事件已开始补持久化幂等 key：`permission.asked`、`question.asked`、关键进度事件和最终态事件会抑制 replay 重复推进
- 幂等策略已支持“同 req 同 payload 去重、同 req 内容更新继续 patch”，不会把合法更新误判成重复事件
- 实时进度分支已抽成可测 helper，`busy / retry / message.updated / message.part.updated` 的 replay 去重已有回归
- 活跃任务在 `/status`、新消息入口和 slash 入口前会先做一次主动探测：若远端已结束则自动收尾 / 明确失败，不再长期卡在陈旧 `running`
- `/status` 已开始展示连接状态、最近进展、最近更新时间和下一步建议，不再只返回裸状态名
- 运行中进度摘要已开始回写到 `task.note`，便于 `/status` 和恢复链路读取最近可见进展
- 连接异常、恢复中、恢复后同步、watchdog 保活等提示文案已开始统一收敛，`/status` 的下一步建议也会结合当前连接状态给出更具体提示
- 飞书消息连接从 `reconnecting / error` 恢复到 `ready` 后，已补轻量 `resume`：等待态提示 / 问题卡片会重发，active task 会主动再探测，不再只停在一条泛化的“连接已恢复”
- watchdog 已开始覆盖等待态：长期无事件的 `waiting_permission / waiting_question / waiting_attachment` 会主动重发提示、继续对账或明确失败，不再只能等连接恢复时被动同步
- `recover / sweep` 已开始区分“远端状态查询失败”和“远端确认空闲”：瞬时探测失败不会再把运行中任务、等待审批或等待问题误判成已结束
- `resume` 已开始统一到同一套语义：message reconnect 后会先探测远端状态，再决定重贴等待卡片、继续同步，还是明确判定旧审批 / 旧问题已失效
- OpenCode SSE 连接状态已补重试次数和退避时间：`/status` 不再只有裸的 `reconnecting`，而会显示第几次重连、约多久后再试
- 飞书长连接状态也已补 reconnect attempt 可见性：`/status` 可以看到 message 侧是否正在连续重连
- 连接抖动提示已开始收敛：`error -> reconnecting` 的单次失败周期只会对活跃任务发一条主提示，避免连续两条连接卡片刷屏
- 重复 `reconnecting -> reconnecting` 状态已不再重复通知，OpenCode SSE 在同一重试阶段内不会继续刷连接卡片
- 若同一 `reconnecting` 阶段内错误原因或重试次数发生实质变化，会立即更新现有连接提示；恢复后再次抖动也不会被旧 cooldown 吞掉
- 上述抖动提示语义已同时覆盖 OpenCode SSE 和飞书长连接：message/opencode 两侧都已补“原因变化即时更新、恢复后再次抖动重新提示”的回归
- `resume` 的 active task 分支已补齐到和 `recover / sweep` 同一口径：message reconnect 后，`queued / acked / running` 会按“继续同步 / 明确失败 / 自动收尾 / 状态未知先保活”统一处理
- OpenCode 在首次 `connecting -> ready` 时也会主动触发恢复：boot 期间若第一次 `recover()` 因服务尚未 ready 只能先保活，后续真正 ready 后会再跑一轮恢复，而不是只能等 watchdog
- boot 阶段若 OpenCode 连接状态尚未落盘，恢复提示也会先收敛成“OpenCode 正在建立连接，稍后继续同步”，后续 `connecting -> ready` 会在同一条进度卡片上继续向前 patch，减少“服务已恢复”这类过早结论
- watchdog 进入“状态未知”分支时也已开始感知 OpenCode 当前连接态：若正在 connecting / reconnecting / error，会优先展示连接建立或重连中的提示，而不是一律退回“长时间无新事件”
- `boot.ts` 中纯文案、状态展示、错误映射 helper 已开始拆到 `src/app/text.ts`，在不改状态机语义的前提下，主文件复杂度和后续交接成本已下降一层
- 通用运行时错误提示已开始区分“可稍后重试”和“需要重发附件 / 重发上一条消息”，主链 `render.err` 已接入带建议的用户提示
- 已补最小自动化回归：命令解析、持久化队列恢复 / 去重 / 重试、消息入口去重入队、`recover()` 关键分支、`waiting_permission / waiting_question / waiting_attachment` 恢复、`on_event()` 的审批 / 问题 / 完成态推进、迟到事件保护、OpenCode SSE 连接失败状态推进、watchdog 远端状态对账、payload 级卡片去重、错误映射与连接提示节流、模型 / 附件错误分级、SQLite 落盘集成测试、富文本 / 附件解析、等待态数字序号语义、`patch` 降级为 reply/send

### 当前主要缺口

- 飞书长连接、OpenCode SSE、后台队列还缺少完整的重连、恢复和幂等补齐
- 当前队列恢复还是“消息入站级恢复”，尚未做到 OpenCode 执行中任务的完整续跑
- 重启后的恢复语义仍不完整，尤其是长耗时任务、等待态任务和迟到事件的恢复
- 请求失败、网络异常、下载失败、模型错误等还缺少更系统的用户提示
- 请求失败和网络异常已开始做统一映射，模型侧错误分级、附件异常细分、SQLite 落盘回归、迟到事件保护、task scope 恢复、OpenCode 事件基础幂等和 `waiting_attachment` 基础恢复都已起步，但更多 provider 特定报错和更细的事件幂等仍待继续收紧
- 长耗时任务的“处理中体验”已有基础 watchdog，但仍缺少更细的超时、卡住、恢复后的提示策略
- 长耗时任务已有基础 watchdog 和远端状态对账，但超时阈值、失败分级、提示节流仍可继续收紧
- 连接状态提示已有第一层接入，但提示文案和节流策略仍可继续收紧
- `/session`、`/model`、`/repo`、`/workspace` 的组合切换还需要更多飞书实链回归
- 多模态回复质量和更复杂的附件交互仍待继续打磨
- 自动化测试仍然偏薄，缺少稳定回归保障
- 自动化测试已起步，但覆盖面仍以解析 / 队列 / 恢复 / 事件推进 / 投递降级为主，离主链全覆盖还有距离

## 下一阶段优先级

### P1: 稳定性与恢复

- 当前下一刀：连接抖动提示、boot 初次恢复文案、ready 后主动恢复和 watchdog 的未知状态提示已基本补齐，下一步继续推进“重启后的 active task 恢复”，重点看 boot 后 queued/running 任务在首次恢复、后续 watchdog、用户侧提示之间的衔接
- 第一步：落 `queue_job` 持久化，补进程重启后的入站消息重放
- 第二步：把 `recover` 从“安全失败”推进到“可恢复则继续、不可恢复则明确失败”
- 飞书长连接自动重连与退避
- OpenCode SSE 自动重连与重订阅
- 队列恢复、幂等回放、迟到事件保护
- 进程重启后的等待态恢复与任务状态恢复

### P2: 失败通知与长耗时体验

- 模型请求失败、下载失败、超时、权限拒绝等错误统一映射为用户可读提示
- 长耗时任务补“仍在处理中 / 已恢复 / 处理失败”的明确反馈
- 卡片 patch 失败时做明确降级，而不是静默丢失更新
- 在连接降级或恢复时给当前活跃会话适度提示

### P3: 会话与模型体验

- `/sessions` 的“查看后切换”体验继续打磨
- `/model` 切换后的状态展示、校验和错误提示补齐
- `session / model / repo / workspace` 的组合切换做更多回归验证

### P4: 多模态体验

- 图片问答回复质量继续优化
- 更复杂的附件-only、多附件、多轮补充说明场景补齐
- 附件失败、缓存命中、超限错误补更清晰的用户提示

### P5: 自动化测试与观测

- 命令解析测试
- 等待态文本回复测试
- 绑定优先级测试
- 附件与富文本解析测试
- 消息入口去重入队测试
- OpenCode 事件推进测试
- OpenCode SSE 失败状态推进测试
- SQLite store 集成测试
- 重连与恢复链路的最小回归测试

## OpenCode Web 持久化调研结论

### 1. 运行态业务数据

OpenCode 本体的核心数据持久化走 SQLite，而不是浏览器存储。

参考实现：

- `packages/opencode/src/storage/db.ts`
- `packages/opencode/src/storage/db.bun.ts`
- `packages/opencode/src/session/session.sql.ts`

当前可以确认：

- 数据库默认是本地 SQLite 文件
- 打开后会启用 `WAL`
- 通过 Drizzle migration 管 schema
- `session`、`message`、`part`、`todo`、`permission` 等核心对象都落在 SQLite 表里

### 2. Web / App 前端状态

OpenCode Web / App 的页面状态、布局缓存、目录级缓存走 `localStorage`，不是 IndexedDB。

参考实现：

- `packages/app/src/utils/persist.ts`
- `packages/app/src/pages/layout.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/context/global-sync/child-store.ts`

当前可以确认：

- 使用 `Persist.global(...)`、`Persist.workspace(...)` 做 key 分层
- 主要持久化布局、工作区顺序、项目元信息缓存、followup 等 UI 状态
- 有本地缓存、限额保护和回退逻辑，但本质仍是浏览器本地存储

### 3. 对 IMUI 的启发

IMUI 是服务端运行时，不是浏览器前端，因此应当更接近 OpenCode 的“SQLite 持久化层”，而不是照搬 Web 的 `localStorage` 方案。

建议分层：

- 业务真状态：SQLite
- 进程内瞬时状态：内存
- 飞书卡片渲染缓存：必要时落 SQLite

## 下一阶段开发顺序

## Phase 9: 连接恢复与幂等

目标：

- 补齐飞书长连接、OpenCode SSE、后台队列的恢复能力
- 让进程重启、连接抖动、事件迟到不再导致“已收到但没有后续”

范围：

- 飞书长连接自动重连与指数退避
- OpenCode `/global/event` 自动重连与重订阅
- `conn_state` 恢复与状态观测
- `queue_job` 持久化与入站消息重放
- 队列恢复与幂等回放
- 消息入口去重入队保护
- OpenCode 事件推进的最小自动化回归
- 迟到事件、重复事件、失效 waiting 状态保护

验收：

- 飞书长连接断开后可自动恢复
- OpenCode 事件桥断开后可自动恢复
- 进程重启后不会长期停在“已收到但无后续”
- 同一请求不会因为重复事件被重复推进

## Phase 10: 失败通知与长耗时体验

目标：

- 让用户在失败、超时、恢复、降级时都能得到明确反馈
- 提升长耗时执行的稳定感和可预期性

范围：

- 模型请求失败提示
- 附件下载 / 缓存失败提示
- 权限拒绝 / 问题超时 / 请求中断提示
- 长耗时任务的“处理中”“恢复中”“已失败”文案
- 卡片 patch 失败后的降级展示

验收：

- 关键失败都能映射成用户可读消息
- 长耗时执行不会只停在模糊的“处理中”
- 连接恢复后，当前活跃任务能有可见反馈

## Phase 11: 会话、模型与多模态体验

目标：

- 打磨 `session / model / repo / workspace` 组合操作体验
- 继续提升图片 / 文件 / 富文本输入后的回复质量

范围：

- `/sessions` 查看后切换体验
- `/model` 状态展示、校验和错误回显
- 复杂附件-only、多附件、多轮补充说明场景
- 图片问答回复质量优化

验收：

- `/session` 与 `/model` 切换后的飞书实链行为稳定
- 多附件与富文本输入后的体验可预期
- 图片问答不再频繁暴露内部工具过程

## Phase 12: 自动化测试与观测

目标：

- 为主链建立稳定回归
- 补齐最小的定位与观测能力

范围：

- 命令解析测试
- 等待态文本回复测试
- 绑定优先级测试
- 附件与富文本解析测试
- SQLite store 集成测试
- 连接恢复与事件幂等测试
- 最小日志与调试辅助

验收：

- 关键主链至少各有一条自动化回归
- 手工飞书回归 case 有固定清单
- 发生线上异常时能较快定位到连接、队列还是 OpenCode 侧

## 里程碑验收标准

### M1

- 飞书长连接和 OpenCode 事件桥恢复稳定
- 队列恢复和事件幂等可用

### M2

- 关键失败都能映射成用户可读提示
- 长耗时执行的状态反馈稳定

### M3

- `session / model / repo / workspace` 组合切换可稳定使用
- 多模态主链体验进一步收紧

### M4

- 自动化回归覆盖主链
- 发生异常时具备基本定位能力

## 风险与对策

## 风险 1: 连接抖动导致状态错乱

对策：

- 为长连接和 SSE 分别维护显式状态机
- 所有恢复逻辑都建立在幂等写入之上

## 风险 2: 长耗时任务在恢复过程中重复推进

对策：

- 关键事件落 `seen_event`
- 按 session 维度串行化任务执行
- 对迟到事件加任务状态保护

## 风险 3: 附件下载和缓存导致磁盘膨胀

对策：

- SQLite 只存元数据
- 文件本体落缓存目录
- 做 TTL 和大小清理策略

## 风险 4: 多模态输入和等待态任务串线

对策：

- 为 `pending_attachment` 和 waiting 状态单独建恢复语义
- 只在同一 thread 内消费下一条文本

## 风险 5: slash 命令语义与 Web / TUI 不一致

对策：

- 把命令分成 IM 原生命令、可转发命令、UI 专属命令三类
- 不强行透传 UI 命令

## 下一步建议

接下来按这个顺序推进：

1. 先做长连接、SSE、队列的重连 / 恢复 / 幂等补齐
2. 再做请求失败、卡片降级和长耗时反馈的用户提示
3. 接着打磨 `session / model / repo / workspace` 的组合体验
4. 最后补自动化回归和观测能力
