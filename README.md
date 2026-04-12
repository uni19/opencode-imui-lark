# OpenCode Feishu IMUI

一个面向飞书 IM 的 OpenCode 交互层设计项目。

当前目录已经包含方案文档和第一批实现骨架，后续开发会继续在这个目录内增量推进。

## 目标

- 让用户可以在飞书私聊或群聊中直接和 OpenCode 交互
- 复用 OpenCode 已有的会话、事件、权限和提问机制
- 先做飞书接入，再为后续扩展到其他 IM 预留抽象

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

## 本地运行

```bash
bun install
bun run start
```

可以通过标准输入喂一条测试消息：

```json
{"kind":"message","chat_id":"oc_demo","user_id":"u_1","message_id":"m_1","text":"帮我看一下当前仓库结构"}
```

## 环境变量

- 参考 `.env.example`
- 当前最关键的是 `IMUI_DB_PATH`、`OPENCODE_BASE_URL`、`OPENCODE_DIRECTORY`、`OPENCODE_PASSWORD`
- 本地联调默认使用 `FEISHU_MODE=stdin`
- 飞书长连接运行时需要 `FEISHU_MODE=long_conn`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`
- `FEISHU_BOT_OPEN_ID` 是可选覆盖项；未配置时，服务会自动拉取应用名做群聊首条 `@bot` 判断

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
- OpenCode 源码: `/Users/bytedance/workspace/opencode`
