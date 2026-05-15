# 12 Operations And Maintenance

## 目标

这份文档用于把“能跑起来”收口到“能维护、能备份、能排查”。

它覆盖三类发布后操作：

- 启动前环境体检
- 缓存与本地数据治理
- SQLite 备份与迁移

## 1. 启动前体检

每次部署、换机器、改配置后，先跑：

```bash
bun run release:doctor
```

如需指定配置文件：

```bash
bun run release:doctor -- --env-file /path/to/.env
```

`release:doctor` 会检查：

- `OPENCODE_BASE_URL` 是否为合法 `http(s)` 地址
- `OPENCODE_PASSWORD` 是否已配置
- `OPENCODE_MODEL` 格式是否为 `<provider>/<model_id>[@<variant>]`
- `FEISHU_MODE=long_conn` 时 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 是否齐全
- 默认目录是否存在
- SQLite 目录、附件缓存目录、备份目录是否可写
- 缓存 TTL、缓存上限、备份保留天数是否合理

约定：

- 有 `warnings` 可以继续启动，但需要人工确认
- 有 `errors` 时不要启动服务

## 2. 运行时目录

默认运行时目录如下：

- 配置目录：`~/.config/opencode-feishu-imui`
- 数据目录：`~/.local/share/opencode-feishu-imui`
- 安装包默认数据库：`<data_dir>/imui.db`
- 默认附件缓存：`<data_dir>/asset`
- 默认备份目录：`<data_dir>/backup`

也可以通过环境变量覆盖：

- `IMUI_CONFIG_DIR`
- `IMUI_DATA_DIR`
- `IMUI_ASSET_CACHE_DIR`
- `IMUI_BACKUP_DIR`

## 3. 附件缓存清理策略

附件缓存现在采用“两段式”治理：

1. 先按 TTL 清理过期文件
2. 再按体积上限清理最老的冷文件

相关配置：

- `IMUI_ASSET_TTL_HOURS`
- `IMUI_ASSET_MAX_MB`

默认值：

- TTL：`168` 小时
- 体积上限：`1024` MB

当前行为：

- 启动时会执行一次清理
- 删除过文件时，会输出 `runtime.cleanup` 日志
- 只清理文件，不清理 SQLite 元数据

建议：

- 调试环境可把 TTL 调短，例如 `24`
- 正式环境不要把 `IMUI_ASSET_MAX_MB` 配得过小，否则多图场景会频繁缓存失效

## 4. SQLite 迁移

当前数据库使用 `PRAGMA user_version` 管 schema 版本。

执行迁移：

```bash
bun run db:migrate
```

指定数据库文件：

```bash
bun run db:migrate -- --db /path/to/imui.db
```

当前策略：

- schema version 由代码内常量维护
- 启动时会自动执行幂等 migration
- 若本地数据库版本高于当前程序支持版本，会直接报错并阻止继续运行

这意味着：

- 升级程序前，先做一次备份
- 不要让旧版本程序直接操作由新版本迁移过的库

## 5. SQLite 备份

执行备份：

```bash
bun run db:backup
```

指定数据库或输出文件：

```bash
bun run db:backup -- --db /path/to/imui.db --out /path/to/backup/imui-20260413.sqlite
```

当前行为：

- 使用 `VACUUM INTO` 生成一致性备份
- 默认写入 `runtime.backup_dir`
- 备份后会按 `IMUI_BACKUP_RETENTION_DAYS` 清理过期备份

默认保留天数：

- `14`

## 6. 恢复建议

当前没有单独的“restore”命令，恢复流程建议如下：

1. 停掉 IMUI 进程
2. 备份当前损坏或待替换的数据库文件
3. 用目标备份文件覆盖运行中的 SQLite 文件
4. 先执行 `bun run db:migrate -- --db <db>` 确认 schema 可读
5. 再执行 `bun run release:doctor -- --env-file <env>` 确认配置无误
6. 最后重新启动服务

## 7. 发布前最小运维门禁

在 `bun test` / `typecheck` / `release:check` 之外，建议至少执行：

```bash
bun run release:doctor
bun run db:migrate
bun run db:backup
```

如果准备正式发版，推荐直接执行：

```bash
bun run release:gate
```

它会顺序跑完测试、类型检查、体检、静态检查、迁移、备份、安装包构建和安装包烟测。

如需指定安装态配置文件，可直接透传：

```bash
bun run release:gate -- --env-file /path/to/.env
```

如果只想对构建好的安装包做一轮自动烟测，可直接执行：

```bash
bun run release:smoke
```

如果这是安装包环境，则建议再补一轮：

1. 安装后运行 `opencode-feishu-imui --help`
2. 检查 `CONFIG_DIR/.env`
3. 用安装态配置跑一遍 `release:doctor`

## 8. 当前限制

- 还没有增量 migration 文件管理器，当前 schema 仍以内建 DDL 为主
- 还没有自动 restore 命令
- 还没有后台周期清理器，当前清理主要依赖启动时执行
- SQLite 仍然是单机文件方案，不适合多实例共享写入
