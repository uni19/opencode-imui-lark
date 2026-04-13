import path from "node:path"
import { cfg } from "../app/cfg.js"
import { loadAppEnv } from "../app/env.js"
import { migrateSqlite, backupSqlite } from "../storage/admin.js"
import { cleanupDir } from "../storage/cleanup.js"

type Command = "backup" | "migrate"

type Args = {
  command: Command
  db?: string
  out?: string
}

function fail(msg: string): never {
  throw new Error(msg)
}

export function parseArgs(argv = process.argv): Args {
  const args = argv.slice(2)
  const command = args[0]
  if (command !== "backup" && command !== "migrate") {
    fail("usage: bun src/release/db.ts <backup|migrate> [--db path] [--out path]")
  }

  let db: string | undefined
  let out: string | undefined

  for (let i = 1; i < args.length; i++) {
    const item = args[i]
    if (!item) continue
    if (item === "--env-file") {
      i += 1
      continue
    }
    if (item.startsWith("--env-file=")) {
      continue
    }
    if (item === "--db") {
      db = args[++i]
      continue
    }
    if (item.startsWith("--db=")) {
      db = item.slice("--db=".length)
      continue
    }
    if (item === "--out") {
      out = args[++i]
      continue
    }
    if (item.startsWith("--out=")) {
      out = item.slice("--out=".length)
      continue
    }
    fail(`unknown option: ${item}`)
  }

  return {
    command,
    db,
    out,
  }
}

function stamp(now = new Date()) {
  const iso = now.toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-").replace("Z", "Z")
  return iso
}

export async function run(argv = process.argv) {
  const args = parseArgs(argv)
  const env = await loadAppEnv({ argv })
  const conf = cfg()
  const file = args.db ?? conf.storage.path
  const db = file === ":memory:" ? file : path.resolve(file)

  if (args.command === "migrate") {
    const sqlite = migrateSqlite(db)
    try {
      console.log(
        JSON.stringify({
          type: "db.migrate",
          env,
          path: db,
          from: sqlite.from,
          to: sqlite.to,
        }),
      )
      return {
        from: sqlite.from,
        to: sqlite.to,
      }
    } finally {
      sqlite.db.close(false)
    }
  }

  if (db === ":memory:") {
    fail("cannot back up :memory: database")
  }

  const backup_dir = path.resolve(conf.runtime?.backup_dir ?? path.join(path.dirname(db), "backup"))
  const out = path.resolve(args.out ?? path.join(backup_dir, `imui-${stamp()}.sqlite`))
  await backupSqlite(db, out)

  const retention_ms = (conf.runtime?.backup_retention_days ?? 14) * 24 * 60 * 60 * 1000
  const cleanup =
    path.dirname(out) === backup_dir
      ? await cleanupDir(backup_dir, {
          ttl_ms: retention_ms,
        })
      : null

  console.log(
    JSON.stringify({
      type: "db.backup",
      env,
      path: db,
      out,
      cleanup,
    }),
  )

  return {
    path: db,
    out,
    cleanup,
  }
}

if (import.meta.main) {
  await run()
}
