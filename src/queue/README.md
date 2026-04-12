# Queue

负责长连接确认路径和后台执行路径之间的解耦。

建议后续文件：

- `bus.ts`: 入队和取队
- `work.ts`: worker 执行
- `retry.ts`: 重试策略
- `lock.ts`: 单会话串行和单活控制

