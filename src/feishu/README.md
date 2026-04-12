# Feishu

负责飞书长连接和飞书出站 API。

建议后续文件：

- `conn.ts`: 建立和维护长连接
- `api.ts`: 发送消息、回复消息、更新卡片
- `map.ts`: 把飞书事件转换成内部类型
- `auth.ts`: tenant token 获取与缓存

当前状态：

- `conn.ts` 已支持 `stdin` 与 `long_conn`
- `api.ts` 已支持真实飞书消息发送、回复、更新
- `map.ts` 已包含消息事件、图片 / 文件 / 富文本消息的基础映射
