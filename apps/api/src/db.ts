import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DB_PATH = process.env.DB_PATH ?? fileURLToPath(new URL('../../../data/laas.db', import.meta.url));

// Each migration runs once, in order; SQLite's `user_version` pragma records how many have run.
// Never edit a migration that has already run somewhere — append a new one instead.
const MIGRATIONS = [
  `CREATE TABLE sessions (
     id               TEXT PRIMARY KEY,
     lab              TEXT NOT NULL,
     state            TEXT NOT NULL CHECK (state IN ('pending', 'running', 'terminating', 'terminated', 'failed')),
     created_at       INTEGER NOT NULL,  -- all times are epoch milliseconds
     started_at       INTEGER,
     expires_at       INTEGER,
     last_activity_at INTEGER NOT NULL,
     ended_at         INTEGER,
     end_reason       TEXT,
     error            TEXT
   );
   CREATE INDEX sessions_state ON sessions (state);`,
];

export function openDb(file = DB_PATH): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL lets readers proceed while a write is in progress; busy_timeout waits instead of failing on a lock.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = applied; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
