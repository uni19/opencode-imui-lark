declare module "bun:sqlite" {
  export type Value = string | number | bigint | boolean | Uint8Array | null

  export type Row = Record<string, unknown>

  export class Statement<T = Row, P extends Value[] = Value[]> {
    get(...params: P): T | null
    all(...params: P): T[]
    run(...params: P): { changes: number; lastInsertRowid: number | bigint }
  }

  export class Database {
    constructor(
      filename: string,
      opts?: {
        create?: boolean
        readonly?: boolean
        safeIntegers?: boolean
        strict?: boolean
      },
    )
    exec(sql: string): void
    query<T = Row, P extends Value[] = Value[]>(sql: string): Statement<T, P>
    close(throwOnError?: boolean): void
  }
}
