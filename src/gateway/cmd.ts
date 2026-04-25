type Cmd =
  | { name: "help" }
  | { name: "status" }
  | { name: "abort" }
  | { name: "new" }
  | { name: "session"; arg?: string }
  | { name: "sessions" }
  | { name: "workspaces" }
  | { name: "skills" }
  | { name: "commands" }
  | { name: "agents" }
  | { name: "model"; arg?: string }
  | { name: "models" }
  | { name: "mcps" }
  | { name: "repo"; scope: "session" | "chat" | "user"; arg?: string; workspace?: string }
  | { name: "slash"; command: string; arguments: string }

function repo(tail: string[]) {
  let scope: "session" | "chat" | "user" = "session"
  let arg: string | undefined
  let workspace: string | undefined

  for (let i = 0; i < tail.length; i++) {
    const item = tail[i]
    if (item === "--chat") {
      scope = "chat"
      continue
    }
    if (item === "--me") {
      scope = "user"
      continue
    }
    if (item === "--workspace") {
      workspace = tail[i + 1] || undefined
      i += 1
      continue
    }
    if (!arg) arg = item
  }

  return { name: "repo" as const, scope, arg, workspace }
}

export function parseCmd(text: string): Cmd | null {
  const val = text.trim()
  if (!val.startsWith("/")) return null
  const [head, ...tail] = val.split(/\s+/)

  if (head === "/help") return { name: "help" }
  if (head === "/status") return { name: "status" }
  if (head === "/abort") return { name: "abort" }
  if (head === "/new") return { name: "new" }
  if (head === "/session") return { name: "session", arg: tail[0] }
  if (head === "/sessions") return { name: "sessions" }
  if (head === "/workspaces") return { name: "workspaces" }
  if (head === "/skills") return { name: "skills" }
  if (head === "/commands") return { name: "commands" }
  if (head === "/agents") return { name: "agents" }
  if (head === "/model") return { name: "model", arg: tail[0] }
  if (head === "/models") return { name: "models" }
  if (head === "/mcps") return { name: "mcps" }
  if (head === "/repo") return repo(tail)
  return { name: "slash", command: head.slice(1), arguments: tail.join(" ") }
}
