import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// A terminal ticket is a tiny JWT-like token: base64url(payload) + "." + base64url(HMAC(payload)).
// It proves "user U may attach to session S until time T" without a database lookup, which matters
// once the terminal is served by a separate gateway (Phase 7/8) that doesn't share our cookies or DB.
// Every process that verifies tickets must share AUTH_SECRET.

const SECRET = process.env.AUTH_SECRET ? Buffer.from(process.env.AUTH_SECRET) : randomBytes(32);
const TICKET_TTL_MS = 30_000; // just long enough to open the WebSocket

export interface TicketClaims {
  sid: string; // lab session id
  uid: string; // user id
  exp: number; // epoch ms
}

const sign = (data: string) => createHmac('sha256', SECRET).update(data).digest();

export function issueTicket(sid: string, uid: string): string {
  const payload = Buffer.from(JSON.stringify({ sid, uid, exp: Date.now() + TICKET_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}

export function verifyTicket(ticket: string): TicketClaims | undefined {
  const [payload, signature] = ticket.split('.');
  if (!payload || !signature) return undefined;

  const expected = sign(payload);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TicketClaims;
  return claims.exp > Date.now() ? claims : undefined;
}
