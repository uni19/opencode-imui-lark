# 05 Interaction Flows

## 流程 1: 普通对话

```text
User -> Feishu
Feishu -> Long Connection Client (im.message.receive_v1)
Long Connection Client -> Gateway Queue
Long Connection Client -> Ack Feishu
Gateway Queue -> SessionRouter
SessionRouter -> OpenCode session.create? -> Gateway Worker
Gateway Worker -> OpenCode session.prompt_async
Gateway Worker -> Feishu ack message
OpenCode -> Event Bridge (/event)
Event Bridge -> Feishu progress updates
OpenCode -> session.status=idle
Event Bridge -> Feishu final message
```

### 关键点

- 长连接线程不等待模型完成
- 长连接线程只做入队和快速确认
- 飞书侧先发占位消息，避免用户误以为机器人无响应
- 文本增量要节流，避免飞书更新频率过高

## 流程 2: 权限审批

```text
OpenCode -> permission.asked
Event Bridge -> Gateway
Gateway -> Feishu approval card
User -> reply 1 / 2 / 3
Feishu -> Long Connection Client (im.message.receive_v1)
Long Connection Client -> Gateway Queue
Gateway Queue -> OpenCode permission.reply
OpenCode -> continue execution
Event Bridge -> Feishu progress/final
```

### 设计细节

- 审批回复需要和当前活跃任务绑定，避免迟到消息串到新任务
- 审批回复只使用数字序号 `1 / 2 / 3` 做选择
- 如果用户直接发送其他文本，则视为“更正当前操作并继续执行”
- 审批消息应带工具名、模式、风险说明和 requestID

## 流程 3: 问题回问

```text
OpenCode -> question.asked
Event Bridge -> Gateway
Gateway -> Feishu question card
User -> reply option index or free text
Feishu -> Long Connection Client (im.message.receive_v1)
Long Connection Client -> Gateway Queue
Gateway Queue -> OpenCode question.reply
OpenCode -> continue execution
```

### 设计细节

- `Question.Info` 天然支持 options、多选和 custom 输入
- 飞书卡片要能表达“选项序号”和“手动补充”
- 存在选项时优先使用数字序号；如问题允许自定义回答，也可直接发送文本
- 回答后应更新原卡片状态，避免用户误以为还未提交

## 流程 4: 用户取消

```text
User -> Feishu (/abort)
Gateway -> OpenCode session.abort
OpenCode -> session.status / session.error / idle
Event Bridge -> Feishu aborted message
```

### 设计细节

- 如果 session 已经 idle，取消应该提示“当前没有执行中的任务”
- 取消命令只对当前活跃任务可用

## 流程 5: 出错

错误来源可能有三类：

### 飞书侧错误

- 长连接断开
- 长连接事件解析失败
- 消息发送失败

处理建议：

- 长连接客户端自动重连
- 后台写错误日志和原始 payload
- 如可恢复，进入重试队列

### Gateway 侧错误

- 数据库错误
- 路由找不到 repo
- 幂等表异常

处理建议：

- 对用户显示友好错误
- 对后台记录详细堆栈和 trace id

### OpenCode 侧错误

- `session.error`
- provider auth 失败
- context overflow
- permission reject

处理建议：

- 将错误映射为用户可读消息
- 对明确可恢复的错误给出下一步建议

## 节流和渲染策略

IM 不适合像 Web 一样持续高频刷新。

建议规则：

- 文本增量 1 到 2 秒合并一次
- 工具状态变化立即刷新
- 审批和问题事件立即发送卡片
- 完成和失败立即发送最终更新

## 文本渲染建议

### 执行中

优先展示：

- 当前阶段
- 最近工具动作
- 已汇总文本片段

### 完成后

优先展示：

- 最终答案
- 如果有文件改动，给出简短 diff 摘要
- 如果需要，附“查看详情”链接

### 超长内容

- 飞书正文只放摘要
- 完整输出可折叠、分段，或落外链

## 长连接特有流程

## 流程 6: 长连接重连

```text
Feishu Long Connection -> disconnected
Conn Manager -> mark reconnecting
Conn Manager -> retry with backoff
Conn Manager -> mark ready
```

### 设计细节

- 连接状态需要持久化到监控或状态表
- 重连期间不应丢掉内部执行状态
- 如果重连失败次数过多，需要告警

## 流程 7: 多实例冲突

```text
Instance A -> connect
Instance B -> connect
Feishu -> random event delivery
Gateway state -> split risk
```

### 设计细节

- 首版只允许一个活跃消费者
- 通过进程锁、数据库锁或 leader 选举保证单活
- 禁止无控制地横向扩容长连接消费者
