# 07 Source Layout

## 目标

本文件定义第一版可开发的 `src/` 目录结构。目标不是一次性定死全部文件，而是先明确：

- 代码按什么边界拆
- 哪些模块可以独立开发
- 哪些类型要共享
- 哪些层不应该互相穿透

## 推荐目录

```text
src/
  README.md
  contracts.ts
  app/
    README.md
  feishu/
    README.md
  gateway/
    README.md
  opencode/
    README.md
  queue/
    README.md
  render/
    README.md
  storage/
    README.md
```

## 分层原则

### `app/`

负责进程启动、配置加载、依赖装配、生命周期管理。

不负责：

- 业务判断
- 协议解析
- 文本渲染

建议后续文件：

```text
src/app/
  main.ts
  cfg.ts
  boot.ts
  text.ts
  validate.ts
  health.ts
```

说明：

- `boot.ts` 保留状态机、恢复链路、副作用编排
- `text.ts` 放纯文案、状态展示、错误映射、恢复提示这类低副作用 helper
- `validate.ts` 放启动前配置体检和 fail-fast 校验，避免把发布约束散落进 `boot.ts`
- 后续如果继续降复杂度，优先把“纯 helper”抽离，避免直接改动状态机主链

### `feishu/`

负责飞书协议适配。

职责：

- 建立长连接
- 接收消息事件
- 发送消息
- 回复消息
- 更新卡片

不负责：

- OpenCode 会话路由
- 业务状态机
- 存储细节

建议后续文件：

```text
src/feishu/
  conn.ts
  api.ts
  map.ts
  ack.ts
  card.ts
```

### `gateway/`

负责业务编排。

职责：

- 处理消息入口
- 路由到会话
- 生成任务
- 决定何时调 OpenCode
- 处理审批和问答的文本回复

建议后续文件：

```text
src/gateway/
  ingest.ts
  session.ts
  task.ts
  router.ts
```

### `opencode/`

负责所有和 OpenCode 交互的逻辑。

职责：

- 封装 SDK
- 调 `session.create`
- 调 `prompt_async`
- 调 `permission.reply`
- 调 `question.reply`
- 订阅 `/event`
- 转换 OpenCode 事件为内部事件

建议后续文件：

```text
src/opencode/
  client.ts
  event.ts
  map.ts
  run.ts
```

### `queue/`

负责解耦长连接确认路径和后台执行路径。

职责：

- 收消息后快速入队
- 串行化同一会话任务
- 控制并发
- 重试和死信

建议后续文件：

```text
src/queue/
  bus.ts
  work.ts
  retry.ts
  lock.ts
```

### `render/`

负责把内部状态渲染成飞书可展示内容。

职责：

- 文本摘要
- 卡片结构
- 进度消息
- 错误消息

建议后续文件：

```text
src/render/
  text.ts
  card.ts
  diff.ts
  err.ts
```

### `storage/`

负责数据库和仓储。

职责：

- 会话映射
- 任务状态
- 幂等键
- 出站消息
- 长连接状态

建议后续文件：

```text
src/storage/
  db.ts
  admin.ts
  cleanup.ts
  session.ts
  task.ts
  msg.ts
  idem.ts
  conn.ts
```

补充说明：

- `admin.ts` 负责 schema version、迁移和备份命令使用的 SQLite 管理逻辑
- `cleanup.ts` 负责附件缓存和备份目录的 TTL / 容量清理策略

### `release/`

负责发布门禁、安装包构建和运维脚本。

建议后续文件：

```text
src/release/
  check.ts
  package.ts
  doctor.ts
  db.ts
```

## 顶层共享文件

### `contracts.ts`

用于保存跨模块共享的核心类型和服务接口。

这份文件的定位是：

- 先作为边界草图
- 后续如果体量变大，再拆成 `contracts/` 目录

## 依赖方向

推荐依赖方向如下：

```text
app
  -> feishu
  -> gateway
  -> opencode
  -> queue
  -> render
  -> storage

gateway
  -> queue
  -> render
  -> storage
  -> opencode

feishu
  -> contracts

opencode
  -> contracts

render
  -> contracts

storage
  -> contracts
```

约束：

- `feishu` 不直接依赖 `opencode`
- `render` 不直接依赖数据库
- `storage` 不知道飞书和 OpenCode 的协议细节

## 最先落地的最小文件集

如果下一步开始写代码，建议先做这几个文件：

```text
src/contracts.ts
src/app/main.ts
src/app/cfg.ts
src/feishu/conn.ts
src/feishu/api.ts
src/queue/bus.ts
src/gateway/ingest.ts
src/gateway/task.ts
src/opencode/client.ts
src/opencode/event.ts
src/storage/db.ts
```

这样能最快跑通：

- 长连接接入
- 入队
- 调 OpenCode
- 回推消息

## 暂不建议提前细分的部分

- 不要一开始就拆太细的 `domain/`, `service/`, `usecase/`, `infra/`
- 不要为了抽象而提前做多 IM 平台插件系统
- 不要过早引入复杂事件总线框架

首版更重要的是路径短、可调试、边界清晰。
