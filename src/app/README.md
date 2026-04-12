# App

负责进程启动、配置加载、依赖装配和生命周期管理。

建议后续从这里开始接：

- `main.ts`
- `cfg.ts`
- `boot.ts`
- `text.ts`
- `health.ts`

当前约定：

- `boot.ts` 负责运行主链、恢复、事件推进和副作用编排
- `text.ts` 负责纯文案 helper、状态展示和错误映射
