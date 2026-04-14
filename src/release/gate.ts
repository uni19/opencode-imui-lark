import { spawnSync } from "node:child_process"

function pass(args: string[]) {
  return args.length > 0 ? ["--", ...args] : []
}

export function gate(args: string[] = process.argv.slice(2)) {
  return [
    ["bun", "test"],
    ["bun", "run", "typecheck"],
    ["bun", "run", "release:doctor", ...pass(args)],
    ["bun", "run", "release:check"],
    ["bun", "run", "db:migrate", ...pass(args)],
    ["bun", "run", "db:backup", ...pass(args)],
    ["bun", "run", "release:build"],
    ["bun", "run", "release:smoke"],
  ] as const
}

function label(cmd: readonly string[]) {
  return cmd.join(" ")
}

export function run(list = gate()) {
  for (const cmd of list) {
    console.log(`\n==> ${label(cmd)}`)
    const out = spawnSync(cmd[0], cmd.slice(1), {
      stdio: "inherit",
    })
    if (out.status !== 0) {
      process.exit(out.status ?? 1)
    }
  }
}

if (import.meta.main) {
  run()
}
