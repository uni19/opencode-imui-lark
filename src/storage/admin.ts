import { mkdirSync } from "node:fs"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"

export const DB_SCHEMA_VERSION = 1

function ensure(file: string) {
  if (file === ":memory:") return file
  mkdirSync(path.dirname(file), { recursive: true })
  return file
}

function quoted(file: string) {
  return `'${file.replaceAll("'", "''")}'`
}

export function schema(db: Database) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS im_session (
      map_key TEXT PRIMARY KEY,
      opencode_session_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS im_session_lookup_idx
    ON im_session (tenant_id, chat_id, thread_id);

    CREATE TABLE IF NOT EXISTS repo_pref (
      pref_key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      chat_id TEXT,
      user_id TEXT,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      req TEXT,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS task_session_idx
    ON task (session_id, created_at);

    CREATE INDEX IF NOT EXISTS task_inbound_idx
    ON task (json_extract(data, '$.inbound_id'), created_at);

    CREATE INDEX IF NOT EXISTS task_req_idx
    ON task (req, created_at);

    CREATE TABLE IF NOT EXISTS inbound_event (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_job (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS queue_job_status_idx
    ON queue_job (status, created_at);

    CREATE TABLE IF NOT EXISTS outbound_message (
      task_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachment (
      attachment_key TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS attachment_lookup_idx
    ON attachment (message_id, asset_key);

    CREATE TABLE IF NOT EXISTS pending_attachment (
      session_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seen_event (
      key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conn_state (
      name TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `)
}

export function version(db: Database) {
  return Number(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0)
}

export function migrateDb(db: Database) {
  const from = version(db)
  if (from > DB_SCHEMA_VERSION) {
    throw new Error(`database schema version ${from} is newer than supported ${DB_SCHEMA_VERSION}`)
  }
  if (from < 1) {
    schema(db)
    db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`)
  } else {
    schema(db)
  }
  return {
    from,
    to: version(db),
  }
}

export function openSqlite(file: string) {
  const db = new Database(ensure(file), { create: true, strict: true })
  migrateDb(db)
  return db
}

export function migrateSqlite(file: string) {
  const db = new Database(ensure(file), { create: true, strict: true })
  const out = migrateDb(db)
  return {
    db,
    ...out,
  }
}

export async function backupSqlite(file: string, out: string) {
  if (file === ":memory:") throw new Error("cannot back up :memory: database")
  mkdirSync(path.dirname(out), { recursive: true })
  await rm(out, { force: true })
  const db = new Database(ensure(file), { create: true, strict: true })
  try {
    db.exec(`VACUUM INTO ${quoted(out)}`)
  } finally {
    db.close(false)
  }
  return out
}
