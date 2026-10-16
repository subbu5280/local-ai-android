/**
 * Test helper: a real SQLite database (Node's built-in node:sqlite) behind the same Db interface that
 * android/.../AiStoreModule.kt provides on the phone, so chatStore's schema and queries run against real SQL in Jest.
 * Foreign keys are on, like the phone module (setForeignKeyConstraintsEnabled(true)).
 */
import type { Db } from '../src/chatStore';

export function sqliteDb(path = ':memory:'): Db & { close(): void; raw: any } {
  const { DatabaseSync } = (globalThis as any).process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(path);
  d.exec('PRAGMA foreign_keys = ON');
  return {
    raw: d,
    close: () => d.close(),
    execute: async (sql, params = []) => d.prepare(sql).run(...params),
    query: async (sql, params = []) => d.prepare(sql).all(...params).map((r: any) => ({ ...r })),
    batch: async statements => {
      d.exec('BEGIN');
      try {
        for (const s of statements) d.prepare(s.sql).run(...(s.params ?? []));
        d.exec('COMMIT');
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
