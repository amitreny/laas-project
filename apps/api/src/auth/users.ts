import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type Role = 'user' | 'admin';

export interface User {
  id: string;
  email: string;
  role: Role;
}

interface UserRow extends User {
  password_hash: string;
  created_at: number;
}

export const LOGIN_TTL_MS = 7 * 24 * 60 * 60_000;

// Tokens are stored hashed: someone who reads the database still can't impersonate anyone.
// (SHA-256 is fine here — unlike passwords, tokens are long random strings, not guessable.)
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class UserStore {
  constructor(private db: DatabaseSync) {}

  /** Returns undefined if the email is taken. */
  create(email: string, passwordHash: string): User | undefined {
    const id = randomUUID();
    try {
      this.db
        .prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(id, email, passwordHash, Date.now());
    } catch (err) {
      if ((err as { errcode?: number }).errcode === 2067 /* SQLITE_CONSTRAINT_UNIQUE */) return undefined;
      throw err;
    }
    return { id, email, role: 'user' };
  }

  findByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  }

  setRole(email: string, role: Role): boolean {
    return this.db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, email).changes === 1;
  }

  // --- login tokens --------------------------------------------------------

  issueToken(userId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + LOGIN_TTL_MS;
    this.db
      .prepare('INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, now, expiresAt);
    // Opportunistic cleanup, so the table doesn't grow forever.
    this.db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now);
    return { token, expiresAt };
  }

  userForToken(token: string): User | undefined {
    return this.db
      .prepare(
        `SELECT u.id, u.email, u.role FROM auth_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND t.expires_at > ?`,
      )
      .get(hashToken(token), Date.now()) as User | undefined;
  }

  /** This is what a stateless JWT can't do: make a login stop working *now*. */
  revokeToken(token: string) {
    this.db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(hashToken(token));
  }
}
