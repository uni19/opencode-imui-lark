# OpenCode Feishu IMUI

一个把 OpenCode 接到飞书 IM 的网关服务。

它负责接收飞书私聊 / 群聊消息，把文本、图片、文件和富文本转换成 OpenCode 可消费的输入，再把执行进度、审批、追问和最终结果回推到飞书。

当前仓库已经不是纯方案稿，已经包含可运行的 Bun 服务、SQLite 持久化、飞书长连接接入、OpenCode HTTP/SSE 对接，以及一批围绕恢复、队列、命令和多模态的自动化测试。

## 你能用它做什么

- 在飞书私聊里直接和 OpenCode 对话
- 在群聊 thread 中 `@bot` 发起会话，并在同一 thread 继续追问
- 使用 `/status`、`/abort`、`/new`、`/session`、`/repo`、`/model` 等命令管理会话
- 上传图片、文件或发送 `post` 富文本，让 OpenCode 基于附件回答
- 在飞书里处理 OpenCode 的权限审批和问题回问

## 当前状态

- 适合本地联调、小范围飞书联调和安装包内测
- 已有较完整的持久化、恢复、状态提示和多模态基础能力
- 已具备安装包构建能力，正式发布前仍需按 [docs/10-release-checklist.md](docs/10-release-checklist.md) 做完整手工回归

## 快速开始

### 1. 最小依赖

- Bun 1.x
- 一个可访问的 OpenCode Server，默认地址是 `http://127.0.0.1:4096`
- 本地可写磁盘目录，用于 SQLite 和附件缓存
- 如果要接真实飞书，还需要飞书企业自建应用

### 2. 安装依赖

```bash
bun install
```

### 3. 配置环境变量

先复制环境变量模板：

```bash
cp .env.example .env
```

本地最小可跑配置：

```env
FEISHU_MODE=stdin
IMUI_DB_PATH=.data/imui.db
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=your-password
OPENCODE_DIRECTORY=/absolute/path/to/your/worktree
```

说明：

- `FEISHU_MODE=stdin` 表示不用真实飞书，直接从标准输入喂测试消息
- `IMUI_DB_PATH` 是 SQLite 文件路径；默认会在仓库下创建 `.data/imui.db`
- `OPENCODE_DIRECTORY` 建议填绝对路径，作为默认工作目录
- `OPENCODE_PASSWORD` 需要与正在运行的 OpenCode Server 保持一致

### 4. 启动服务

先在另一个终端启动 OpenCode Server：

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --hostname 127.0.0.1 --port 4096
```

然后再启动 IMUI：

```bash
bun run start
```

开发时可用热重载：

```bash
bun run dev
```

### 5. 用 stdin 做一轮本地联调

服务启动后，向 stdin 发送一条 NDJSON 消息：

```json
{"kind":"message","chat_id":"oc_demo","user_id":"u_1","message_id":"m_1","text":"帮我看一下当前仓库结构"}
```

如果 OpenCode Server、数据库和目录配置都正确，服务会开始创建任务并输出处理结果。

## 文档索引

- `docs/01-goals-and-scope.md`: 项目目标、边界、非目标
- `docs/02-architecture.md`: 总体架构与模块职责
- `docs/03-session-and-message-model.md`: 会话、消息、事件和状态模型
- `docs/04-api-contracts.md`: 网关和 OpenCode 的接口契约
- `docs/05-interaction-flows.md`: 核心交互时序和异常流程
- `docs/06-delivery-plan.md`: MVP 范围、拆分顺序、验收标准
- `docs/07-source-layout.md`: `src/` 目录设计和代码分层建议
- `docs/08-module-sketch.md`: 模块职责、接口草图和启动顺序
- `docs/09-junior-engineer-playbook.md`: 初级工程师接手开发的执行手册和发布前任务清单
- `docs/10-release-checklist.md`: 发布前环境检查、自动化门禁和飞书手工回归清单
- `docs/11-packaging-and-install.md`: 安装包构建、安装路径和烟测步骤
- `docs/12-operations-and-maintenance.md`: 启动前体检、缓存清理、SQLite 备份与迁移
- `docs/13-feishu-scope-minimum.md`: 飞书最小权限范围和发布前 scope 核对方法
- `docs/14-end-user-readme.md`: 面向最终安装用户的安装、配置、启动和使用说明

## 当前结论

- 不改 OpenCode 内核协议，优先通过 `opencode serve` 暴露的 HTTP API 和 SSE 事件实现
- IM 接入层做成独立网关服务，负责飞书长连接、协议翻译、幂等、消息卡片和状态回推
- SDK 优先使用 `@opencode-ai/sdk/v2`，因为它包含 `permission` 和 `question` 能力，适合 IM 审批回环

## 网络前提

- 机器可以在 NAT 网络下运行，不要求公网 IP
- 不要求自有域名，也不要求公网 HTTPS webhook 入口
- 运行环境必须具备公网出站能力，用于连接飞书长连接通道和调用飞书发送消息 API

## 飞书接入结论

- 飞书消息接收和新版卡片交互统一采用长连接方案
- 不再依赖“将回调发送至开发者服务器”的公网 webhook 模式
- 网关收到飞书长连接事件后只做轻处理和入队，重逻辑异步执行
- 必须使用企业自建应用，并统一采用新版卡片交互协议

## 当前架构摘要

```text
Feishu Open Platform
   <-> Long Connection Clients
       -> Gateway Runtime
           -> OpenCode Server
           -> OpenCode Event Bridge
           -> Feishu Send API
```

## 实现骨架

- `src/contracts.ts`: 当前推荐的跨模块类型和服务接口草图
- `src/README.md`: 代码目录的整体说明
- `src/feishu/`: 飞书长连接和出站 API
- `src/gateway/`: 入口编排、会话路由、任务状态
- `src/opencode/`: OpenCode SDK 和事件桥
- `src/render/`: 文本与卡片渲染
- `src/storage/`: 数据持久化和仓储
- `src/queue/`: 入队、调度和后台 worker
- `src/app/`: 进程启动和依赖装配

## 当前代码状态

- 已有两条接入链路：`stdin` 本地联调，以及 `long_conn` 飞书长连接
- 基础 SQLite 持久化已接入，`session`、`task`、默认 repo 绑定、入站去重、出站消息记录、附件缓存和 `pending_attachment` 不再只存在内存中
- 飞书出站已支持真实消息发送、回复和卡片更新；未配置飞书凭证时会自动退回控制台桩
- 已接好会话路由、任务状态、SSE 事件监听、权限/问题回问主链
- 单轮消息已支持“占位回复 -> 处理中 patch -> 审批/追问 patch -> 最终结果 patch”的单条更新链路
- 这条单消息更新链路基于飞书“共享卡片”实现，避免对普通文本消息执行 `patch` 时返回 400
- 处理中进度已做节流聚合，并会把常见工具步骤压缩成更短的摘要文案
- 群聊已支持 `@bot` 起新会话，并按 `tenant + chat + thread/root` 隔离上下文；同一 thread 内后续回复可直接继续
- 已支持当前会话、当前聊天、当前用户三层 repo 绑定；新会话按“会话显式绑定 > 聊天默认 > 用户默认 > 全局默认”选目录
- 已支持飞书图片、文件和 `post` 富文本消息；多图、图文混排会统一拆成 `text + file parts`，附件-only 输入会先进入“等待补充说明”，用户补一条文本后再一起送入 OpenCode
- `/session`、`/model`、`/repo`、`/workspace` 相关命令已补自动化回归
- 多图、多附件、附件-only 补充说明、最终回复过滤内部文本等关键多模态场景已补自动化回归

## 环境变量

- 参考 [.env.example](.env.example)
- 默认模式是 `FEISHU_MODE=stdin`
- 真实飞书模式需要把 `FEISHU_MODE` 改成 `long_conn`

常用变量：

- `LOG_LEVEL`: 日志级别，默认 `info`
- `IMUI_DB_PATH`: SQLite 数据库路径，默认 `.data/imui.db`
- `IMUI_CONFIG_DIR`: 可选；显式指定配置目录
- `IMUI_DATA_DIR`: 可选；显式指定数据目录
- `IMUI_ASSET_CACHE_DIR`: 可选；显式指定附件缓存目录
- `IMUI_BACKUP_DIR`: 可选；显式指定数据库备份目录
- `IMUI_ASSET_TTL_HOURS`: 附件缓存 TTL，默认 `168`
- `IMUI_ASSET_MAX_MB`: 附件缓存体积上限，默认 `1024`
- `IMUI_BACKUP_RETENTION_DAYS`: 备份保留天数，默认 `14`
- `FEISHU_MODE`: `stdin` / `long_conn` / `off`
- `FEISHU_APP_ID`: 飞书应用 App ID
- `FEISHU_APP_SECRET`: 飞书应用 App Secret
- `FEISHU_BOT_OPEN_ID`: 可选；显式指定 bot open id，群聊首条 `@bot` 判断会更稳定
- `OPENCODE_BASE_URL`: OpenCode Server 地址，默认 `http://127.0.0.1:4096`
- `OPENCODE_USERNAME`: OpenCode 用户名，默认 `opencode`
- `OPENCODE_PASSWORD`: OpenCode 密码
- `OPENCODE_DIRECTORY`: 默认工作目录
- `OPENCODE_WORKSPACE`: 默认 workspace
- `OPENCODE_AGENT`: 默认 agent
- `OPENCODE_MODEL`: 默认模型

## 飞书模式配置

如果要连真实飞书，至少需要完成下面配置。

### 飞书控制台

- 创建企业自建应用
- 开启机器人能力
- 事件订阅方式选择“使用长连接接收事件”
- 至少订阅 `im.message.receive_v1`
- 补齐消息接收、发送、图片/文件下载、卡片交互相关 scope

### 本地环境变量

```env
FEISHU_MODE=long_conn
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=your-password
OPENCODE_DIRECTORY=/absolute/path/to/your/worktree
```

说明：

- `FEISHU_BOT_OPEN_ID` 不是强制项，但建议配置，能减少群聊首条 `@bot` 判断歧义
- 如果不填 `FEISHU_BOT_OPEN_ID`，服务会回退到按应用名称匹配 mention
- 真实飞书联调前，请先跑完自动化测试，再按发布清单逐项手工验证

## 当前支持的 IM 命令

- `/help`: 查看帮助
- `/status`: 查看当前会话状态和目录绑定
- `/abort`: 取消当前执行
- `/new`: 新建会话；如果上一轮仍在运行，会先尝试取消
- `/session`: 查看当前会话
- `/session <session_id>`: 切换当前会话
- `/repo`: 查看当前目录绑定
- `/repo <directory>`: 为当前会话绑定目录；若目录变更，会同步切换到新的 OpenCode session
- `/repo --chat <directory>`: 为当前聊天设置默认目录，后续新会话优先继承
- `/repo --me <directory>`: 为当前用户设置默认目录，跨聊天复用
- `/sessions`: 查看当前目录下最近会话
- `/model`: 查看当前模型和默认模型
- `/model <provider>/<model_id>`: 为当前会话切换模型
- `/model reset`: 恢复当前会话到默认模型
- `/skills`: 查看当前可用技能
- `/agents`: 查看当前可用 agent
- `/models`: 查看当前已连接 provider / model，返回模型名称和 model id
- `/mcps`: 查看当前 MCP 状态
- `/commands`: 查看当前可转发 slash 命令
- `/repo --workspace <workspace>`: 为当前会话绑定 workspace
- `/repo <directory> --workspace <workspace>`: 同时绑定目录和 workspace
- `--chat` / `--me` 可与 `--workspace` 组合使用，例如 `/repo --chat /repo/path --workspace ws_local`
- 未命中的 slash 会尝试透传到 OpenCode 执行，例如 `/init`

## 飞书控制台配置

- 事件订阅方式选择“使用长连接接收事件”，至少订阅 `im.message.receive_v1`
- 应用需要开启机器人能力，并补齐消息发送、接收相关 scope

## 验证命令

在仓库根目录执行：

```bash
bun test
bun run typecheck
bun run release:doctor
bun run release:check
bun run db:migrate
bun run db:backup
bun run release:build
```

其中：

- `bun run release:doctor` 会做启动前环境体检
- `bun run release:check` 会校验静态发布条件，例如环境变量模板、忽略项和发布文档是否齐全
- `bun run db:migrate` / `bun run db:backup` 用于验证 SQLite 管理链路可用

如果你准备发版或做真实飞书联调，再补一轮 [docs/10-release-checklist.md](docs/10-release-checklist.md) 中的手工回归。

## 安装包构建

默认构建当前机器目标：

```bash
bun run release:build
```

构建产物会放在 `dist/release/`，包含：

- 平台对应的单文件二进制
- `install.sh`
- `uninstall.sh`
- `opencode-feishu-imui-service` 服务助手
- 包内 README、服务说明和安装态 `.env` 模板
- 对应的 `.tar.gz` 安装包

如果要构建指定目标：

```bash
bun run release:build -- --target bun-darwin-arm64
```

支持的打包目标

- `bun-darwin-arm64`
- `bun-darwin-x64`
- `bun-linux-arm64`
- `bun-linux-x64`

更完整的打包与安装说明见 [docs/11-packaging-and-install.md](docs/11-packaging-and-install.md)。

安装后如果希望长期运行，可用：

```bash
opencode-feishu-imui-service install
opencode-feishu-imui-service uninstall
```

在用户级注册 `launchd` / `systemd --user` 服务。

## 运维与安全收口

发布前建议再确认三件事：

- 用 [docs/12-operations-and-maintenance.md](docs/12-operations-and-maintenance.md) 跑一遍 `release:doctor`、缓存清理和 SQLite 备份/迁移检查
- 用 [docs/13-feishu-scope-minimum.md](docs/13-feishu-scope-minimum.md) 对照飞书控制台，把 scope 收敛到当前功能最小集合
- 按 [docs/10-release-checklist.md](docs/10-release-checklist.md) 完成一次真实飞书手工回归

## 本地数据与提交注意事项

- 本地数据库默认写到 `.data/`
- `.env`、`.data/`、日志和常见缓存目录不应提交
- 如果工作树里已经存在本地 `.env` 或 `.data/`，发版前也要再确认一次它们没有被误加入暂存区
- 发版前请确认仓库中没有个人 token、临时截图、调试日志或本地附件缓存

## 群聊规则

- 群聊新 thread 的首条消息需要 `@bot`
- 同一 thread 内如果已存在会话，后续跟进消息可以不重复 `@`
- 未配置 `FEISHU_BOT_OPEN_ID` 时，新消息按飞书事件里的 mention 名称与应用名匹配
- 图片、文件和 `post` 富文本中的图片 / 文件节点会下载为本地缓存文件，再作为 OpenCode `file part` 输入
- 只有附件、没有文字时，bot 会先要求用户补一句“想让我做什么”
- 等待权限审批时，数字 `1`、`2`、`3` 用于选择；如果直接发送其他文本，会被视为“拒绝并附带说明”
- 等待问题回问时，如存在选项，优先回复序号；如需多选，可回复 `1,2`；若该问题允许自定义回答，也可以直接发文字

## 关键参考

- OpenCode Server: https://opencode.ai/docs/zh-cn/server/
- OpenCode SDK: https://opencode.ai/docs/zh-cn/sdk/
- OpenCode Web: https://opencode.ai/docs/zh-cn/web/
- OpenCode 源码: 独立仓库 `opencode`
