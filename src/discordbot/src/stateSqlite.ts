// SQLite-backed StateAdapter for chat-sdk on Bun's bun:sqlite.
//
// We ship our own rather than using chat-adapter-sqlite (which needs
// python/make/g++ at install time for better-sqlite3) or Redis (which
// needs an extra container + volume). bun:sqlite is built in and
// synchronous, so no native-compile step and no thread juggling.
//
// Single-host only: locks rely on SQLite's own file locking, not
// distributed coordination. Persistence is the point - the DB file
// survives container restarts so the bot doesn't forget its
// subscriptions, cached keys, and queued messages.
//
// TTL cleanup is lazy on reads plus a periodic sweep (default every 60s).
// Reads always respect expiry regardless of whether the sweep has run.

import { Database } from "bun:sqlite";
import type { Lock, QueueEntry, StateAdapter } from "chat";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscriptions (
  thread_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS kv_expires_idx ON kv(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS lists (
  key        TEXT NOT NULL,
  position   INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, position)
);
CREATE INDEX IF NOT EXISTS lists_key_idx ON lists(key);

CREATE TABLE IF NOT EXISTS queues (
  thread_id TEXT NOT NULL,
  position  INTEGER NOT NULL,
  entry     TEXT NOT NULL,
  PRIMARY KEY (thread_id, position)
);
CREATE INDEX IF NOT EXISTS queues_thread_idx ON queues(thread_id);
`;

export type SqliteStateOptions = {
  /** Path to the SQLite file. ":memory:" works for tests. */
  path: string;
  /** Sweep interval (ms) for expired rows. 0 disables (use for tests). */
  cleanupIntervalMs?: number;
};

export class BunSqliteStateAdapter implements StateAdapter {
  private readonly db: Database;
  private readonly cleanupIntervalMs: number;
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  constructor(options: SqliteStateOptions) {
    this.db = new Database(options.path, { create: true });
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.db.exec(SCHEMA);
    this.connected = true;
    if (this.cleanupIntervalMs > 0) {
      this.sweepHandle = setInterval(
        () => this.sweepExpired(),
        this.cleanupIntervalMs,
      );
      this.sweepHandle.unref?.();
    }
  }

  async disconnect(): Promise<void> {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    this.connected = false;
    this.db.close();
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    this.db
      .prepare(
        "INSERT INTO subscriptions (thread_id) VALUES ($id) ON CONFLICT DO NOTHING",
      )
      .run({ $id: threadId });
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    this.db
      .prepare("DELETE FROM subscriptions WHERE thread_id = $id")
      .run({ $id: threadId });
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();
    const row = this.db
      .prepare("SELECT 1 FROM subscriptions WHERE thread_id = $id")
      .get({ $id: threadId });
    return row !== null;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    const now = Date.now();
    const token = generateToken();
    const expiresAt = now + ttlMs;

    // Atomic insert-or-take-over-expired. The WHERE clause on the
    // ON CONFLICT branch ensures we never steal a live lock.
    const result = this.db
      .prepare(
        `INSERT INTO locks (thread_id, token, expires_at)
         VALUES ($id, $token, $exp)
         ON CONFLICT (thread_id) DO UPDATE SET
           token = excluded.token,
           expires_at = excluded.expires_at
         WHERE locks.expires_at <= $now`,
      )
      .run({ $id: threadId, $token: token, $exp: expiresAt, $now: now });

    if (result.changes === 0) return null;
    return { threadId, token, expiresAt };
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    // Token check: if another caller force-released and re-acquired,
    // we must not delete their lock.
    this.db
      .prepare("DELETE FROM locks WHERE thread_id = $id AND token = $token")
      .run({ $id: lock.threadId, $token: lock.token });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected();
    this.db
      .prepare("DELETE FROM locks WHERE thread_id = $id")
      .run({ $id: threadId });
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE locks
         SET expires_at = $exp
         WHERE thread_id = $id AND token = $token AND expires_at > $now`,
      )
      .run({
        $id: lock.threadId,
        $token: lock.token,
        $exp: now + ttlMs,
        $now: now,
      });
    return result.changes > 0;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();
    const now = Date.now();
    const row = this.db
      .prepare("SELECT value, expires_at FROM kv WHERE key = $key")
      .get({ $key: key }) as
      | { value: string; expires_at: number | null }
      | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) {
      this.db
        .prepare("DELETE FROM kv WHERE key = $key AND expires_at = $exp")
        .run({ $key: key, $exp: row.expires_at });
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    ttlMs?: number,
  ): Promise<void> {
    this.ensureConnected();
    this.db
      .prepare(
        `INSERT INTO kv (key, value, expires_at) VALUES ($key, $value, $exp)
         ON CONFLICT (key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at`,
      )
      .run({
        $key: key,
        $value: JSON.stringify(value),
        $exp: ttlMs ? Date.now() + ttlMs : null,
      });
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number,
  ): Promise<boolean> {
    this.ensureConnected();
    const now = Date.now();
    const expiresAt = ttlMs ? now + ttlMs : null;
    // Transaction so "evict-if-expired then insert" is atomic.
    const txn = this.db.transaction(
      (args: {
        key: string;
        value: string;
        exp: number | null;
        now: number;
      }): number => {
        this.db
          .prepare(
            "DELETE FROM kv WHERE key = $key AND expires_at IS NOT NULL AND expires_at <= $now",
          )
          .run({ $key: args.key, $now: args.now });
        const res = this.db
          .prepare(
            `INSERT INTO kv (key, value, expires_at) VALUES ($key, $value, $exp)
             ON CONFLICT (key) DO NOTHING`,
          )
          .run({ $key: args.key, $value: args.value, $exp: args.exp });
        return res.changes;
      },
    );
    return (
      txn({ key, value: JSON.stringify(value), exp: expiresAt, now }) > 0
    );
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    this.db.prepare("DELETE FROM kv WHERE key = $key").run({ $key: key });
    this.db.prepare("DELETE FROM lists WHERE key = $key").run({ $key: key });
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    this.ensureConnected();
    const now = Date.now();
    const expiresAt = options?.ttlMs ? now + options.ttlMs : null;

    const txn = this.db.transaction(
      (args: {
        key: string;
        value: string;
        exp: number | null;
        maxLength: number | null;
        now: number;
      }): void => {
        // If expired, purge before appending; caller should see a fresh list.
        this.db
          .prepare(
            `DELETE FROM lists
             WHERE key = $key AND expires_at IS NOT NULL AND expires_at <= $now`,
          )
          .run({ $key: args.key, $now: args.now });

        // COALESCE because MAX() on an empty set returns NULL, and NULL+1=NULL in SQLite.
        const maxRow = this.db
          .prepare(
            "SELECT COALESCE(MAX(position), -1) AS max_pos FROM lists WHERE key = $key",
          )
          .get({ $key: args.key }) as { max_pos: number };

        this.db
          .prepare(
            `INSERT INTO lists (key, position, value, expires_at)
             VALUES ($key, $pos, $value, $exp)`,
          )
          .run({
            $key: args.key,
            $pos: maxRow.max_pos + 1,
            $value: args.value,
            $exp: args.exp,
          });

        // Sync the expiry onto every row so the list has one logical TTL.
        if (args.exp !== null) {
          this.db
            .prepare("UPDATE lists SET expires_at = $exp WHERE key = $key")
            .run({ $key: args.key, $exp: args.exp });
        }

        if (args.maxLength !== null && args.maxLength > 0) {
          this.db
            .prepare(
              `DELETE FROM lists
               WHERE key = $key
                 AND position <= (
                   SELECT MAX(position) FROM lists WHERE key = $key
                 ) - $max`,
            )
            .run({ $key: args.key, $max: args.maxLength });
        }
      },
    );

    txn({
      key,
      value: JSON.stringify(value),
      exp: expiresAt,
      maxLength: options?.maxLength ?? null,
      now,
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected();
    const rows = this.db
      .prepare(
        `SELECT value, expires_at FROM lists
         WHERE key = $key
         ORDER BY position ASC`,
      )
      .all({ $key: key }) as {
      value: string;
      expires_at: number | null;
    }[];

    if (rows.length === 0) return [];

    // All rows share the same expires_at (kept in sync by appendToList).
    const expiresAt = rows[0]!.expires_at;
    if (expiresAt !== null && expiresAt <= Date.now()) {
      this.db.prepare("DELETE FROM lists WHERE key = $key").run({ $key: key });
      return [];
    }
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number,
  ): Promise<number> {
    this.ensureConnected();
    const txn = this.db.transaction(
      (args: { id: string; entry: string; max: number }): number => {
        const maxRow = this.db
          .prepare(
            "SELECT COALESCE(MAX(position), -1) AS max_pos FROM queues WHERE thread_id = $id",
          )
          .get({ $id: args.id }) as { max_pos: number };

        this.db
          .prepare(
            `INSERT INTO queues (thread_id, position, entry)
             VALUES ($id, $pos, $entry)`,
          )
          .run({
            $id: args.id,
            $pos: maxRow.max_pos + 1,
            $entry: args.entry,
          });

        if (args.max > 0) {
          this.db
            .prepare(
              `DELETE FROM queues
               WHERE thread_id = $id
                 AND position <= (
                   SELECT MAX(position) FROM queues WHERE thread_id = $id
                 ) - $max`,
            )
            .run({ $id: args.id, $max: args.max });
        }

        const countRow = this.db
          .prepare("SELECT COUNT(*) AS n FROM queues WHERE thread_id = $id")
          .get({ $id: args.id }) as { n: number };
        return countRow.n;
      },
    );
    return txn({
      id: threadId,
      entry: JSON.stringify(entry),
      max: maxSize,
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected();
    const now = Date.now();
    const txn = this.db.transaction(
      (args: { id: string; now: number }): QueueEntry | null => {
        // Drop expired entries first. json_extract reads the expiresAt
        // field out of each row's serialized QueueEntry.
        this.db
          .prepare(
            `DELETE FROM queues
             WHERE thread_id = $id
               AND (
                 SELECT json_extract(entry, '$.expiresAt') FROM queues q
                 WHERE q.thread_id = $id AND q.position = queues.position
               ) <= $now`,
          )
          .run({ $id: args.id, $now: args.now });

        const row = this.db
          .prepare(
            `SELECT position, entry FROM queues
             WHERE thread_id = $id
             ORDER BY position ASC
             LIMIT 1`,
          )
          .get({ $id: args.id }) as
          | { position: number; entry: string }
          | null;
        if (!row) return null;

        this.db
          .prepare(
            "DELETE FROM queues WHERE thread_id = $id AND position = $pos",
          )
          .run({ $id: args.id, $pos: row.position });

        return JSON.parse(row.entry) as QueueEntry;
      },
    );
    return txn({ id: threadId, now });
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected();
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM queues WHERE thread_id = $id")
      .get({ $id: threadId }) as { n: number };
    return row.n;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error(
        "BunSqliteStateAdapter is not connected. Call connect() first.",
      );
    }
  }

  private sweepExpired(): void {
    const now = Date.now();
    this.db
      .prepare("DELETE FROM locks WHERE expires_at <= $now")
      .run({ $now: now });
    this.db
      .prepare(
        "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= $now",
      )
      .run({ $now: now });
    this.db
      .prepare(
        "DELETE FROM lists WHERE expires_at IS NOT NULL AND expires_at <= $now",
      )
      .run({ $now: now });
  }
}

function generateToken(): string {
  return `sqlt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function createSqliteState(
  options: SqliteStateOptions,
): BunSqliteStateAdapter {
  return new BunSqliteStateAdapter(options);
}
