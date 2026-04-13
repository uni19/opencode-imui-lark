# Source Layout

`src/` 目录保存后续实现代码。

当前阶段已经有最小可运行骨架，后续会在现有分层上补全飞书长连接、真实发送接口和持久化实现。

## 目录

- `contracts.ts`: 跨模块共享类型和服务接口草图
- `app/`: 进程启动、配置和依赖装配
- `app/validate.ts`: 启动前配置体检与 fail-fast 校验
- `feishu/`: 飞书长连接和出站 API
- `gateway/`: 入口编排、会话路由、任务状态
- `opencode/`: OpenCode SDK 和事件桥
- `queue/`: 入队、调度和后台 worker
- `render/`: 文本和卡片渲染
- `storage/`: 数据持久化和仓储
- `storage/admin.ts`: SQLite schema version、迁移和备份工具
- `storage/cleanup.ts`: 附件缓存与备份目录清理策略
- `release/`: 发布检查、安装包构建和运维脚本

## 当前策略

- 先保证路径短、边界清楚
- 不提前做复杂插件系统
- 不提前做多 IM 抽象
- 先用 `stdin` 跑通本地回路，再补飞书长连接正式接入
