# 10 Release Checklist

## 目标

这份文档用于发布前逐项检查，避免项目达到“功能大致可用”，但在真实飞书环境里仍有明显缺口。

适用场景：

- 本地提测前
- 飞书联调前
- 版本发布前
- 线上问题回归后

## 使用方式

每次准备发布前，按顺序执行：

1. 先做环境检查
2. 再做自动化验证
3. 再做飞书手工回归
4. 最后确认发布内容

任何一项失败，都不要进入发布。

## 1. 环境检查

### 代码与配置

- [ ] `README.md` 与当前实现一致
- [ ] `.env.example` 与当前配置项一致
- [ ] 未把本地调试路径、临时账号、个人 token 写进代码或文档
- [ ] `.gitignore` 已覆盖 `.data/`、日志、缓存等本地运行数据
- [ ] 工作树里若已存在 `.env`、`.data/` 等本地文件，已确认它们未被纳入暂存区或待提交内容

### 运行依赖

- [ ] `bun install` 可完成
- [ ] `FEISHU_MODE` 已按目标环境设置为 `stdin` 或 `long_conn`
- [ ] 若使用真实飞书：`FEISHU_APP_ID` 已配置
- [ ] 若使用真实飞书：`FEISHU_APP_SECRET` 已配置
- [ ] `OPENCODE_BASE_URL` 已指向可访问的 OpenCode Server
- [ ] `OPENCODE_PASSWORD` 已配置且和服务端一致
- [ ] `OPENCODE_DIRECTORY` 已配置且目录真实存在
- [ ] 若要验证 workspace：`OPENCODE_WORKSPACE` 已配置或已准备可用 workspace 名称
- [ ] `IMUI_DB_PATH` 所在目录可写
- [ ] `IMUI_ASSET_TTL_HOURS`、`IMUI_ASSET_MAX_MB`、`IMUI_BACKUP_RETENTION_DAYS` 已按目标环境确认
- [ ] 已先执行 `bun run release:doctor`，且输出中没有 `errors`

### 飞书控制台

- [ ] 已启用机器人能力
- [ ] 已订阅 `im.message.receive_v1`
- [ ] 事件订阅方式为“使用长连接接收事件”
- [ ] 所需 scope 已补齐，并已按 [docs/13-feishu-scope-minimum.md](13-feishu-scope-minimum.md) 做最小化确认
- [ ] 机器人已被加入用于联调的群聊

## 2. 自动化验证

发布前至少执行：

```bash
bun test
bun run typecheck
bun run release:doctor
bun run release:check
bun run release:gate
bun run db:migrate
bun run db:backup
bun run release:build
bun run release:smoke
```

如果需要指定安装态或临时验证配置，可统一用：

```bash
bun run release:gate -- --env-file /path/to/.env
```

如果只想针对已经构建出的安装包做自动烟测，可执行：

```bash
bun run release:smoke
```

### 自动化门禁

- [ ] `bun test` 全绿
- [ ] `bun run typecheck` 全绿
- [ ] `bun run release:doctor` 全绿
- [ ] `bun run release:check` 全绿
- [ ] `bun run release:gate` 全绿
- [ ] `bun run db:migrate` 可执行
- [ ] `bun run db:backup` 可执行
- [ ] `bun run release:build` 可产出目标安装包
- [ ] `bun run release:smoke` 可完成安装包烟测
- [ ] 没有新增跳过测试
- [ ] 没有删除已有恢复/事件/队列相关测试却缺少补充说明
- [ ] 本次变更影响到的 Task Pack 结果已回写 `docs/06-delivery-plan.md`

### 安装包门禁

- [ ] `dist/release/` 中已生成目标平台的 `.tar.gz`
- [ ] 安装包中包含真实二进制、`install.sh`、`uninstall.sh`、包内 README、服务说明、`.env` 模板
- [ ] 安装脚本能在临时 `PREFIX` 下完成安装
- [ ] 安装后的 `opencode-feishu-imui --help` 可执行
- [ ] 安装后的 `opencode-feishu-imui-service install` / `uninstall` 可执行
- [ ] 安装后会生成默认配置文件 `~/.config/opencode-feishu-imui/.env` 或目标 `CONFIG_DIR/.env`
- [ ] 安装后能用安装态配置再跑一遍 `release:doctor`

### 数据与运维门禁

- [ ] 已确认附件缓存目录和备份目录落在预期位置
- [ ] 已确认缓存 TTL / 容量上限符合目标环境
- [ ] 已至少生成一份 SQLite 备份
- [ ] 已确认数据库迁移命令可正常执行
- [ ] 已确认当前版本支持读取目标 SQLite schema version

## 3. 飞书手工回归清单

下面这些 case 是最小发布门禁。

## A. 文本主链

- [ ] 私聊发送普通文本，能收到最终回复
- [ ] 群聊新 thread 首条 `@bot` 可触发会话
- [ ] 同一 thread 后续消息无需重复 `@`
- [ ] 群聊非 `@bot` 的新 thread 不会误触发

## B. Slash 命令主链

- [ ] `/help`
- [ ] `/status`
- [ ] `/new`
- [ ] `/abort`
- [ ] `/sessions`
- [ ] `/workspaces`
- [ ] `/session <id>`
- [ ] 正在运行中的 session 可切走到后台继续执行
- [ ] `/repo`
- [ ] `/repo --chat <directory>`
- [ ] `/repo --me <directory>`
- [ ] `/repo --workspace <workspace>`
- [ ] `/model`
- [ ] `/model <provider>/<model>`
- [ ] `/model reset`
- [ ] `/commands`
- [ ] 未命中的 slash 能正确透传或明确失败

## C. 审批与追问

- [ ] 权限审批能展示
- [ ] 点击权限卡片按钮可正确生效
- [ ] 纯数字文本不会被当作权限审批选择
- [ ] 非数字文本会按当前语义走“更正当前操作并继续执行”
- [ ] 问题回问可用
- [ ] 选项题通过卡片提交；允许自由文本的问题可直接发送非数字文本；无选项问题可直接文本回答
- [ ] 后台 session 的审批 / 追问不会抢当前前台 thread
- [ ] 切回对应 session 后，审批 / 追问能恢复显示

## D. 多模态输入

- [ ] 单图 + 文本
- [ ] 多图 + 文本
- [ ] 文件 + 文本
- [ ] 文件 + 图片 + 说明
- [ ] 图文混排 `post`
- [ ] 附件-only 输入会进入等待说明
- [ ] 附件-only 状态下连续补多次附件不会丢失前面的附件
- [ ] 附件-only 后再补一条文本能继续执行
- [ ] 后台 session 的等待补附件提示不会主动打断当前前台 session
- [ ] 切回对应 session 后，补附件提示会恢复显示
- [ ] 回复里不暴露内部工具过程、缓存路径、summary 文本

## E. 长耗时与恢复

- [ ] 长耗时任务中 `/status` 可读
- [ ] 长耗时任务中 `/abort` 可用
- [ ] 处理中卡片会更新，不长期停在首条占位
- [ ] OpenCode 短暂断连后，用户能看到恢复中提示
- [ ] 飞书长连接短暂断连后，用户能看到恢复中提示
- [ ] 重启服务后，活跃任务不会长期悬空
- [ ] 后台 running task 在切走 session 后仍能正常完成或失败收尾

## 4. 发布内容检查

### 代码内容

- [ ] 没有提交调试日志
- [ ] 没有提交截图、临时文件、个人测试数据
- [ ] 没有残留 `console.log` 式噪音输出
- [ ] 没有未使用的大块试验代码
- [ ] `.data/`、日志、缓存目录没有被纳入提交内容
- [ ] 没有把个人 scope 配置截图、个人应用配置导出物提交进仓库

### 文档内容

- [ ] README 启动步骤可直接执行
- [ ] 命令列表完整
- [ ] 当前限制和已知行为有记录
- [ ] 若新增了用户语义，文档已同步

## 5. 发布阻断条件

出现下面任一情况，不应发布：

- 自动化测试不通过
- `typecheck` 不通过
- 私聊或群聊主链不可用
- 审批或追问不可用
- 附件主链不可用
- `/status` 或 `/abort` 不可用
- 长耗时任务容易长期卡住
- 连接恢复后状态明显错乱
- `release:doctor` 有错误但仍强行启动
- SQLite 备份 / 迁移链路不可用

## 6. 问题归因速查

### 看起来像飞书问题

常见表现：

- 消息收不到
- 卡片更新失败
- 群聊 `@bot` 判断异常

优先看：

- `src/feishu/conn.ts`
- `src/feishu/api.ts`
- `src/feishu/map.ts`
- `docs/13-feishu-scope-minimum.md`

### 看起来像 OpenCode 问题

常见表现：

- prompt 发出后一直没进展
- `/status` 显示连接异常
- 最终答复拿不到

优先看：

- `src/opencode/client.ts`
- `src/opencode/event.ts`
- `src/app/boot.ts`
- `src/app/validate.ts`

### 看起来像恢复 / 状态机问题

常见表现：

- 重启后卡住
- 恢复后重复提示
- 迟到事件污染已完成任务

优先看：

- `src/app/boot.ts`
- `test/recover.test.ts`
- `test/watch.test.ts`
- `test/probe.test.ts`
- `test/boot.test.ts`
- `docs/12-operations-and-maintenance.md`

## 7. 每次发布后的记录模板

建议在发布记录里保留下面内容：

```md
### Release YYYY-MM-DD

- 版本目标：
- 自动化验证：
- 飞书手工验证：
- 已知限制：
- 发布风险：
- 回滚策略：
```

## 最后原则

发布前最重要的不是“功能看起来很多”，而是：

- 主链稳定
- 恢复可预期
- 用户提示清楚
- 出问题时能定位

只要这四件事没有同时满足，就还不算真正可发布。
