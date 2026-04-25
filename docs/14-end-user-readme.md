# 14 End User README

## 这是什么

`opencode-feishu-imui` 是一个把 OpenCode 接到飞书里的本地网关服务。

安装并启动后，你可以：

- 在飞书私聊里直接和 OpenCode 对话
- 在群聊 thread 中 `@bot` 发起和继续会话
- 上传图片、文件、富文本，让 OpenCode 基于附件回答
- 在飞书里处理权限审批和问题回问

## 安装前准备

在开始前，请先确认：

1. 你已经拿到安装包 `opencode-feishu-imui-<version>-<target>.tar.gz`
2. 机器可以访问 OpenCode Server
3. 如果要接真实飞书，已经准备好飞书企业自建应用
4. 机器具备公网出站能力，可以访问飞书开放平台

## 1. 安装

解压安装包并进入目录：

```bash
tar -xzf opencode-feishu-imui-<version>-<target>.tar.gz
cd opencode-feishu-imui-<version>-<target>
```

执行安装：

```bash
./install.sh
```

默认安装后会得到：

- 可执行入口：`~/.local/bin/opencode-feishu-imui`
- 配置目录：`~/.config/opencode-feishu-imui`
- 数据目录：`~/.local/share/opencode-feishu-imui`

如果你希望改安装位置，也可以在安装时覆盖：

```bash
PREFIX=/opt/opencode-feishu-imui \
CONFIG_DIR=/etc/opencode-feishu-imui \
DATA_DIR=/var/lib/opencode-feishu-imui \
./install.sh
```

## 2. 配置

安装脚本会自动生成：

```text
~/.config/opencode-feishu-imui/.env
```

请编辑这个文件。

### 最小本地配置

如果你只想先本地验证服务能否启动：

```env
FEISHU_MODE=stdin
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=your-password
OPENCODE_DIRECTORY=/absolute/path/to/your/worktree
```

### 真实飞书配置

如果你要接飞书真实聊天：

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

推荐确认这些变量：

- `FEISHU_MODE`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BOT_OPEN_ID`
- `OPENCODE_BASE_URL`
- `OPENCODE_USERNAME`
- `OPENCODE_PASSWORD`
- `OPENCODE_DIRECTORY`

如果你不想用默认数据目录，还可以配置：

- `IMUI_DATA_DIR`
- `IMUI_ASSET_CACHE_DIR`
- `IMUI_BACKUP_DIR`

## 3. 启动前自检

正式启动前，建议先跑一次：

```bash
opencode-feishu-imui --help
```

以及在源码仓库中跑一次：

```bash
bun run release:doctor -- --env-file ~/.config/opencode-feishu-imui/.env
```

`release:doctor` 会帮助你检查：

- OpenCode 地址是否合法
- 密码是否缺失
- 目录是否存在
- 缓存和备份目录是否可写
- 长连接模式下飞书凭证是否完整

## 4. 启动 OpenCode Server

请先在另一终端启动 OpenCode Server：

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --hostname 127.0.0.1 --port 4096
```

说明：

- 这里的密码要和 `.env` 中的 `OPENCODE_PASSWORD` 保持一致
- 默认用户名就是 `opencode`，因此和 IMUI 默认配置可以直接对齐
- 如果你修改了 OpenCode Server 的地址或端口，也要同步更新 `OPENCODE_BASE_URL`

## 5. 启动 IMUI

直接启动：

```bash
opencode-feishu-imui
```

如果你是手工指定配置文件，也可以：

```bash
opencode-feishu-imui --env-file /path/to/.env
```

启动成功后，日志里会打印一条 `type=boot` 的配置摘要。

## 6. 长期运行（可选）

如果你希望服务在本机长期运行，可执行：

```bash
opencode-feishu-imui-service install
```

移除用户级服务：

```bash
opencode-feishu-imui-service uninstall
```

说明：

- macOS 默认安装为 `launchd` 用户服务
- Linux 默认安装为 `systemd --user` 服务
- 服务助手会复用安装时记录的安装目录、配置目录和数据目录

日志查看：

- macOS：查看 `<DATA_DIR>/log/stdout.log` 和 `stderr.log`
- Linux：使用 `systemctl --user status opencode-feishu-imui` 或 `journalctl --user -u opencode-feishu-imui`

## 7. 飞书侧检查

如果使用真实飞书，请再确认：

1. 应用已开启机器人能力
2. 事件订阅方式是“使用长连接接收事件”
3. 已订阅 `im.message.receive_v1`
4. 已补齐当前功能需要的 scope
5. 机器人已经加入目标私聊 / 群聊场景

## 8. 如何使用

启动后，你可以在飞书中：

- 私聊 bot 直接发送文本
- 在群聊 thread 首条消息 `@bot`
- 上传图片、文件、富文本进行提问

常用命令：

- `/help`
- `/status`
- `/new`
- `/abort`
- `/repo`
- `/sessions`
- `/workspaces`
- `/model`

## 9. 常见问题

### 启动后没有收到飞书消息

先检查：

- `FEISHU_MODE` 是否为 `long_conn`
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 是否正确
- 飞书控制台是否已开启长连接事件订阅

### 可以收到消息，但回复失败

先检查：

- OpenCode Server 是否可访问
- `OPENCODE_PASSWORD` 是否正确
- 飞书应用是否具备发送和更新消息能力

### 图片 / 文件无法处理

先检查：

- 飞书应用是否具备消息附件读取能力
- 数据目录和附件缓存目录是否可写

### 服务安装后没有自动拉起

先检查：

- macOS 是否存在 `~/Library/LaunchAgents/com.opencode-feishu-imui.plist`
- Linux 是否存在 `~/.config/systemd/user/opencode-feishu-imui.service`
- 是否使用同一用户执行了 `opencode-feishu-imui-service install`
- Linux 若需要退出登录后继续运行，是否已为当前用户启用 lingering

## 10. 卸载

执行安装包里的卸载脚本：

```bash
./uninstall.sh
```

注意：

- 卸载默认只删除可执行入口和二进制
- 配置目录和数据目录会保留，方便后续重新安装

## 11. 当前限制

- 当前仍以单机部署为主
- 默认数据库是本地 SQLite
- 暂未提供 Windows 安装包
- 当前只提供用户级 `launchd` / `systemd --user` 服务助手
