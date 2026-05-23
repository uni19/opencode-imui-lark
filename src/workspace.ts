const remote_workspace_prefix = "wrk"

export function normalizeWorkspace(val?: string) {
  const item = val?.trim()
  if (!item) return
  if (!item.startsWith(remote_workspace_prefix)) return
  return item
}

export function parseWorkspaceSelection(val?: string) {
  const item = val?.trim()
  if (!item) {
    return {
      ok: true as const,
      workspace: undefined,
    }
  }
  if (item.startsWith(remote_workspace_prefix)) {
    return {
      ok: true as const,
      workspace: item,
    }
  }
  return {
    ok: false as const,
    value: item,
  }
}
