# 11 Packaging And Install

## 目标

把项目从“源码仓库可运行”推进到“可产出安装包并在目标机器安装”。

当前安装包方案是：

- 用 `bun build --compile` 产出单文件二进制
- 以平台为单位生成 `.tar.gz` 安装包
- 安装包内自带 `install.sh` / `uninstall.sh`
- 安装后默认使用 `~/.config/opencode-feishu-imui/.env` 作为配置文件

## 支持的打包目标

- `bun-darwin-arm64`
- `bun-darwin-x64`
- `bun-linux-arm64`
- `bun-linux-x64`

## 构建命令

### 构建当前机器目标

```bash
bun run release:build
```

### 构建指定目标

```bash
bun run release:build -- --target bun-darwin-arm64
```

### 一次构建多个目标

```bash
bun run release:build -- \
  --target bun-darwin-arm64 \
  --target bun-linux-x64
```

## 产物结构

构建完成后，产物默认位于：

```text
dist/release/
  opencode-feishu-imui-<version>-<target>/
  opencode-feishu-imui-<version>-<target>.tar.gz
```

解压后的目录包含：

- `bin/opencode-feishu-imui`: 编译后的真实二进制
- `install.sh`: 安装脚本
- `uninstall.sh`: 卸载脚本
- `share/README-package.md`: 面向最终用户的安装、配置和启动说明
- `share/README-service.md`: 服务安装和常驻运行说明
- `share/service-helper.sh`: `launchd` / `systemd --user` 服务助手脚本
- `share/opencode-feishu-imui.env.example`: 安装态配置模板
- `share/README-source.md`: 源码仓库 README 副本

## 安装行为

默认执行：

```bash
./install.sh
```

安装脚本会：

- 把真实二进制复制到 `~/.local/lib/opencode-feishu-imui/`
- 生成启动包装器 `~/.local/bin/opencode-feishu-imui`
- 生成服务助手 `~/.local/bin/opencode-feishu-imui-service`
- 生成配置目录 `~/.config/opencode-feishu-imui`
- 生成数据目录 `~/.local/share/opencode-feishu-imui`
- 若不存在配置文件，则创建 `~/.config/opencode-feishu-imui/.env`
- 记录安装时使用的 `PREFIX / CONFIG_DIR / DATA_DIR`，供后续启动包装器和服务助手复用

运行时默认还会在数据目录下继续使用：

- `asset/`: 附件缓存
- `backup/`: SQLite 备份目录

可通过环境变量覆盖安装位置：

- `PREFIX`
- `CONFIG_DIR`
- `DATA_DIR`

## 配置加载顺序

运行时按下面顺序找配置：

1. `--env-file /path/to/.env`
2. `IMUI_ENV_FILE`
3. 当前工作目录下的 `.env`
4. `~/.config/opencode-feishu-imui/.env`

安装脚本生成的包装器会显式传入：

```text
--env-file ~/.config/opencode-feishu-imui/.env
```

因此安装后的用户不需要依赖当前工作目录。

## 长期运行

如果目标机器需要常驻运行，可执行：

```bash
opencode-feishu-imui-service install
opencode-feishu-imui-service uninstall
```

说明：

- macOS 默认使用 `launchd` 用户服务
- Linux 默认使用 `systemd --user`
- 服务助手会复用安装时记录的 `PREFIX / CONFIG_DIR / DATA_DIR`
- 如需覆盖，也可以在执行时临时设置同名环境变量

默认日志位置：

```text
<DATA_DIR>/log/
```

其中：

- macOS 会写 `stdout.log` / `stderr.log`
- Linux 建议用 `systemctl --user status opencode-feishu-imui` 和 `journalctl --user -u opencode-feishu-imui` 查看

## 发布前最小验证

至少执行：

```bash
bun test
bun run typecheck
bun run release:doctor
bun run release:check
bun run db:migrate
bun run db:backup
bun run release:build
```

然后再做一次安装包烟测：

1. 解压 `dist/release/*.tar.gz`
2. 在临时目录执行 `./install.sh`
3. 执行 `opencode-feishu-imui --help`
4. 确认 `~/.config/opencode-feishu-imui/.env` 已生成
5. 回到源码仓库，用安装态配置再跑一遍 `bun run release:doctor -- --env-file ~/.config/opencode-feishu-imui/.env`
6. 如需要常驻运行，再执行一次 `opencode-feishu-imui-service install`
7. 按 [docs/10-release-checklist.md](10-release-checklist.md) 做飞书回归

仓库内还有一份对应的最终用户说明，可作为发布附件或对外文档来源：

- [docs/14-end-user-readme.md](14-end-user-readme.md)

## 当前限制

- 暂未提供 Windows 安装包
- 当前只提供用户级 `launchd` / `systemd --user` 服务助手，未提供系统级守护进程安装
- 暂未做自动更新能力
- SQLite 仍是单机本地持久化
