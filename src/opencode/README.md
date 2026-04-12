# OpenCode

负责 OpenCode SDK 和事件桥。

建议后续文件：

- `client.ts`: SDK 封装
- `event.ts`: 订阅 `/event` 或 `/global/event`
- `map.ts`: OpenCode 事件到内部事件的转换
- `run.ts`: prompt、abort、permission、question 调用

