import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type SessionState = 'pending' | 'running' | 'terminating' | 'terminated' | 'failed';

export type EndReason =
  | 'user' // stopped from the UI / API
  | 'expired' // hit its TTL
  | 'idle' // nobody attached for too long
  | 'container_lost' // the runtime lost the container (crash, OOM kill, someone ran `docker rm`)
  | 'disk_limit' // wrote more to its filesystem than the lab allows
  | 'provision_failed' // image missing, setup script failed, ...
  | 'interrupted'; // the API restarted mid-provisioning

// The only legal moves. A transition from any other state is refused, which is how
// concurrent actors (user, reaper, reconciler, provisioner) avoid trampling each other.
const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  pending: ['running', 'terminating', 'failed'],
  running: ['terminating'],
  terminating: ['terminated'],
  terminated: [],
  failed: [],
};

export const ACTIVE_STATES: readonly SessionState[] = ['pending', 'running', 'terminating'];

export interface SessionRow {
  id: string;
  lab: string;
  user_id: string | null;
  state: SessionState;
  created_at: number;
  started_at: number | null;
  expires_at: number | null;
  last_activity_at: number;
  ended_at: number | null;
  end_reason: EndReason | null;
  error: string | null;
}

type MutableFields = Partial<Omit<SessionRow, 'id' | 'lab' | 'user_id' | 'state' | 'created_at'>>;

export interface Limits {
  perUser: number;
  global: number;
}

export type InsertResult = { session: SessionRow } | { error: 'user_limit' | 'capacity' };

const ACTIVE_SQL = `state IN ('pending', 'running', 'terminating')`;

export class SessionStore {
  constructor(private db: DatabaseSync) {}

  /**
   * Count-then-insert inside one write transaction. Without it, two simultaneous requests could both
   * see "0 active" and both insert. BEGIN IMMEDIATE takes the write lock up front, so this holds even
   * with several API processes sharing the database.
   */
  insertWithinLimits(id: string, lab: string, userId: string, now: number, limits: Limits): InsertResult {
    const count = (sql: string, ...args: string[]) =>
      (this.db.prepare(`SELECT count(*) AS n FROM sessions WHERE ${sql}`).get(...args) as { n: number }).n;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let error: 'user_limit' | 'capacity' | undefined;
      if (count(`user_id = ? AND ${ACTIVE_SQL}`, userId) >= limits.perUser) error = 'user_limit';
      else if (count(ACTIVE_SQL) >= limits.global) error = 'capacity';
      else {
        this.db
          .prepare(
            `INSERT INTO sessions (id, lab, user_id, state, created_at, last_activity_at)
             VALUES (:id, :lab, :userId, 'pending', :now, :now)`,
          )
          .run({ id, lab, userId, now });
      }
      this.db.exec('COMMIT');
      return error ? { error } : { session: this.get(id)! };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listByState(...states: SessionState[]): SessionRow[] {
    const placeholders = states.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM sessions WHERE state IN (${placeholders}) ORDER BY created_at`)
      .all(...states) as unknown as SessionRow[];
  }

  listActiveForUser(userId: string): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE user_id = ? AND ${ACTIVE_SQL} ORDER BY created_at`)
      .all(userId) as unknown as SessionRow[];
  }

  /**
   * Compare-and-set: moves the session to `to` only if its *current* state allows it, in a single
   * UPDATE. Returns false if the session was already moved elsewhere — i.e. someone else won the race.
   */
  transition(id: string, to: SessionState, fields: MutableFields = {}): boolean {
    const from = (Object.keys(TRANSITIONS) as SessionState[]).filter((s) => TRANSITIONS[s].includes(to));
    const sets = Object.keys(fields).map((k) => `${k} = :${k}`);
    const { changes } = this.db
      .prepare(
        `UPDATE sessions SET ${['state = :to', ...sets].join(', ')}
         WHERE id = :id AND state IN (${from.map((s) => `'${s}'`).join(', ')})`,
      )
      .run({ ...(fields as Record<string, SQLInputValue>), id, to });
    return changes === 1;
  }

  touch(id: string, now: number) {
    this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ? AND state = 'running'`).run(now, id);
  }

  setExpiry(id: string, expiresAt: number): boolean {
    const { changes } = this.db
      .prepare(`UPDATE sessions SET expires_at = ? WHERE id = ? AND state = 'running'`)
      .run(expiresAt, id);
    return changes === 1;
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The API's view of a session. */
export const toDto = (s: SessionRow) => ({
  id: s.id,
  lab: s.lab,
  userId: s.user_id,
  state: s.state,
  createdAt: iso(s.created_at),
  startedAt: iso(s.started_at),
  expiresAt: iso(s.expires_at),
  endedAt: iso(s.ended_at),
  endReason: s.end_reason,
  error: s.error,
});
