// SQLite-backed StateAdapter for chat-sdk, built on Bun's native bun:sqlite.
//
// Why we wrote our own:
// - chat-adapter-sqlite uses better-sqlite3, which needs python/make/g++ at
//   install time. Adding those to our image is ~200MB of bloat for a
//   single dependency.
// - Redis works but adds an extra container + volume to the deploy.
// - bun:sqlite is synchronous, built in, and has no native-compile step.
//
// This implements the full 19-method StateAdapter contract. It is single-
// host only (no distributed locks). Persistence is the whole point: the
// DB file survives container restarts so the bot doesn't forget which
// threads it was subscribed to, which keys it had cached, which messages
// were queued, etc.
//
// The adapter performs lazy TTL cleanup on reads plus a periodic sweep
// (every 60s) for expired locks so stale entries don't accumulate. Reads
// always respect expiry — you won't see a value the caller set with a TTL
// that has since elapsed, even if the row is still on disk.

import { Database } from "bun:sqlite";
import type { Lock, QueueEntry, StateAdapter } from "chat";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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
  value      TEXT NOT NULL,        -- JSON
  expires_at INTEGER                -- NULL = no expiry, unix ms otherwise
);
CREATE INDEX IF NOT EXISTS kv_expires_idx ON kv(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS lists (
  key        TEXT NOT NULL,
  position   INTEGER NOT NULL,
  value      TEXT NOT NULL,        -- JSON
  expires_at INTEGER,               -- copied onto every row so whole-list expiry is a simple delete
  PRIMARY KEY (key, position)
);
CREATE INDEX IF NOT EXISTS lists_key_idx ON lists(key);

CREATE TABLE IF NOT EXISTS queues (
  thread_id TEXT NOT NULL,
  position  INTEGER NOT NULL,
  entry     TEXT NOT NULL,          -- JSON (QueueEntry)
  PRIMARY KEY (thread_id, position)
);
CREATE INDEX IF NOT EXISTS queues_thread_idx ON queues(thread_id);
`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type SqliteStateOptions = {
  /** Path to the SQLite file. ":memory:" works for tests. */
  path: string;
  /**
   * How often to sweep expired locks from disk (ms). Reads always respect
   * expiry regardless; the sweep is just housekeeping so stale rows don't
   * accumulate. 0 disables the sweep (useful for tests so timers don't
   * keep the event loop alive).
   */
  cleanupIntervalMs?: number;
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class BunSqliteStateAdapter implements StateAdapter {
  private readonly db: Database;
  private readonly cleanupIntervalMs: number;
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  constructor(options: SqliteStateOptions) {
    this.db = new Database(options.path, { create: true });
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;
    this.db.exec(SCHEMA);
    this.connected = true;
    if (this.cleanupIntervalMs > 0) {
      this.sweepHandle = setInterval(
        () => this.sweepExpired(),
        this.cleanupIntervalMs,
      );
      // Don't keep the event loop alive just for the sweeper.
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

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    const now = Date.now();
    const token = generateToken();
    const expiresAt = now + ttlMs;

    // Atomic: insert new lock OR take over an expired one. The WHERE clause
    // on ON CONFLICT ensures we only overwrite expired locks, not live ones.
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
    // Only delete if the token matches — otherwise another caller has
    // acquired the lock since (per force-release semantics) and we must
    // not steal theirs.
    this.db
      .prepare(
        "DELETE FROM locks WHERE thread_id = $id AND token = $token",
      )
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
    const newExpiresAt = now + ttlMs;
    const result = this.db
      .prepare(
        `UPDATE locks
         SET expires_at = $exp
         WHERE thread_id = $id AND token = $token AND expires_at > $now`,
      )
      .run({
        $id: lock.threadId,
        $token: lock.token,
        $exp: newExpiresAt,
        $now: now,
      });
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Key-value cache
  // -------------------------------------------------------------------------

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();
    const now = Date.now();
    const row = this.db
      .prepare(
        "SELECT value, expires_at FROM kv WHERE key = $key",
      )
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
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
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
        $exp: expiresAt,
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
    // Wrap in a transaction to atomically evict-if-expired + insert.
    const txn = this.db.transaction((args: {
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
    });
    const changes = txn({
      key,
      value: JSON.stringify(value),
      exp: expiresAt,
      now,
    });
    return changes > 0;
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    this.db.prepare("DELETE FROM kv WHERE key = $key").run({ $key: key });
    this.db.prepare("DELETE FROM lists WHERE key = $key").run({ $key: key });
  }

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------

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
        // If the list has expired, clear it before we append. That way the
        // caller sees a fresh list, not stale entries + the new one.
        this.db
          .prepare(
            `DELETE FROM lists
             WHERE key = $key AND expires_at IS NOT NULL AND expires_at <= $now`,
          )
          .run({ $key: args.key, $now: args.now });

        // Compute next position. MAX(position) returns null when the list
        // is empty, which (null) + 1 = null in SQLite, so coalesce.
        const maxRow = this.db
          .prepare(
            "SELECT COALESCE(MAX(position), -1) AS max_pos FROM lists WHERE key = $key",
          )
          .get({ $key: args.key }) as { max_pos: number };
        const nextPos = maxRow.max_pos + 1;

        this.db
          .prepare(
            `INSERT INTO lists (key, position, value, expires_at)
             VALUES ($key, $pos, $value, $exp)`,
          )
          .run({
            $key: args.key,
            $pos: nextPos,
            $value: args.value,
            $exp: args.exp,
          });

        // Refresh the expires_at on every row in the list so the list's
        // TTL is a single logical value. Skip if no TTL was given.
        if (args.exp !== null) {
          this.db
            .prepare(
              "UPDATE lists SET expires_at = $exp WHERE key = $key",
            )
            .run({ $key: args.key, $exp: args.exp });
        }

        // Trim to maxLength from the left (oldest). A SQL DELETE by
        // position threshold is clean and atomic.
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
    const now = Date.now();
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

    // All rows share the same expires_at (we keep it in sync in
    // appendToList). If expired, clear and return empty.
    const expiresAt = rows[0]!.expires_at;
    if (expiresAt !== null && expiresAt <= now) {
      this.db.prepare("DELETE FROM lists WHERE key = $key").run({ $key: key });
      return [];
    }

    return rows.map((r) => JSON.parse(r.value) as T);
  }

  // -------------------------------------------------------------------------
  // Queues
  // -------------------------------------------------------------------------

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
        const nextPos = maxRow.max_pos + 1;

        this.db
          .prepare(
            `INSERT INTO queues (thread_id, position, entry)
             VALUES ($id, $pos, $entry)`,
          )
          .run({ $id: args.id, $pos: nextPos, $entry: args.entry });

        // Trim oldest to maxSize. Same trick as lists.
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
          .prepare(
            "SELECT COUNT(*) AS n FROM queues WHERE thread_id = $id",
          )
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
    // Pop in a transaction: read oldest live entry + delete it atomically.
    // Also drop expired entries in the same pass so callers don't have to.
    const txn = this.db.transaction(
      (args: { id: string; now: number }): QueueEntry | null => {
        // Discard stale entries.
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
      .prepare(
        "SELECT COUNT(*) AS n FROM queues WHERE thread_id = $id",
      )
      .get({ $id: threadId }) as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

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
