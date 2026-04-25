export const LOCAL_COMMANDS = [
  { name: "/help", description: "查看帮助" },
  { name: "/status", description: "查看当前会话状态" },
  { name: "/abort", description: "取消当前执行" },
  { name: "/new", description: "新建会话" },
  { name: "/session", description: "查看或切换当前会话" },
  { name: "/repo", description: "查看或绑定目录 / workspace" },
  { name: "/sessions", description: "查看当前目录 / workspace 下最近会话" },
  { name: "/workspaces", description: "查看当前目录下可用 workspace" },
  { name: "/model", description: "查看或切换当前模型" },
  { name: "/skills", description: "查看当前目录 / workspace 下可用技能" },
  { name: "/commands", description: "查看当前目录 / workspace 下可转发 slash 命令" },
  { name: "/agents", description: "查看当前目录 / workspace 下可用 agent" },
  { name: "/models", description: "查看当前目录 / workspace 下已连接 provider / model" },
  { name: "/mcps", description: "查看当前目录 / workspace 下 MCP 状态" },
] as const

export const LOCAL_COMMAND_NAMES = LOCAL_COMMANDS.map((item) => item.name)
