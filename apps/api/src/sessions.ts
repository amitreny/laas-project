import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type SessionState = 'pending' | 'running' | 'terminating' | 'terminated' | 'failed';

export type EndReason =
  | 'user' // stopped from the UI / API
  | 'expired' // hit its TTL
  | 'idle' // nobody attached for too long
  | 'container_lost' // the runtime lost the container (crash, OOM kill, someone ran `docker rm`)
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
  state: SessionState;
  created_at: number;
  started_at: number | null;
  expires_at: number | null;
  last_activity_at: number;
  ended_at: number | null;
  end_reason: EndReason | null;
  error: string | null;
}

type MutableFields = Partial<Omit<SessionRow, 'id' | 'lab' | 'state' | 'created_at'>>;

export class SessionStore {
  constructor(private db: DatabaseSync) {}

  insert(id: string, lab: string, now: number): SessionRow {
    this.db
      .prepare(
        `INSERT INTO sessions (id, lab, state, created_at, last_activity_at)
         VALUES (:id, :lab, 'pending', :now, :now)`,
      )
      .run({ id, lab, now });
    return this.get(id)!;
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
  state: s.state,
  createdAt: iso(s.created_at),
  startedAt: iso(s.started_at),
  expiresAt: iso(s.expires_at),
  endedAt: iso(s.ended_at),
  endReason: s.end_reason,
  error: s.error,
});
