import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DUMMY_HASH, hashPassword, verifyPassword } from './passwords.js';
import { LOGIN_TTL_MS, type User, type UserStore } from './users.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

const COOKIE = 'laas_auth';

const email = z.string().trim().toLowerCase().pipe(z.email());
const SignupBody = z.object({ email, password: z.string().min(8, 'password must be at least 8 characters').max(200) });
// Don't validate password rules on login: that would hint at the policy, and old accounts may predate it.
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });

// Brute-force protection: login and signup get a much tighter per-IP limit than the rest of the API.
const strictRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

const sameOrigin = (origin: string, host: string | undefined) => {
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // includes the literal "null" origin sent by sandboxed pages
  }
};

/** Adds `req.user`, CSRF protection and the /api/auth routes to the root instance. */
export async function registerAuth(app: FastifyInstance, users: UserStore) {
  await app.register(cookie);
  app.decorateRequest('user', null);

  // Resolve the logged-in user once per request; routes then just read req.user.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[COOKIE];
    req.user = token ? (users.userForToken(token) ?? null) : null;
  });

  // CSRF defense in depth. SameSite=Lax already keeps our cookie off most cross-site requests;
  // on top of that, browsers always send Origin on cross-site writes, so refuse any that aren't ours.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin && !sameOrigin(origin, req.headers.host)) {
      return reply.code(403).send({ error: 'cross-origin request refused' });
    }
  });

  const logIn = (reply: FastifyReply, userId: string) => {
    const { token } = users.issueToken(userId);
    reply.setCookie(COOKIE, token, {
      httpOnly: true, // page JavaScript can't read it, so an XSS bug can't steal it
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // HTTPS-only outside local dev
      path: '/',
      maxAge: LOGIN_TTL_MS / 1000,
    });
  };

  app.post('/api/auth/signup', { config: strictRateLimit }, async (req, reply) => {
    const body = SignupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });

    const user = users.create(body.data.email, await hashPassword(body.data.password));
    // Note: this tells an attacker the email is registered. Real platforms avoid that by always
    // replying "check your inbox" and doing the rest over email verification.
    if (!user) return reply.code(409).send({ error: 'an account with that email already exists' });

    logIn(reply, user.id);
    return reply.code(201).send(user);
  });

  app.post('/api/auth/login', { config: strictRateLimit }, async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'email and password are required' });

    const row = users.findByEmail(body.data.email);
    // Always run scrypt, even for unknown emails, so timing doesn't reveal which accounts exist.
    const ok = await verifyPassword(body.data.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) return reply.code(401).send({ error: 'wrong email or password' });

    logIn(reply, row.id);
    return { id: row.id, email: row.email, role: row.role } satisfies User;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) users.revokeToken(token);
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req, reply) => req.user ?? reply.code(401).send({ error: 'not signed in' }));
}

/** preHandler for routes that need a logged-in user. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'not signed in' });
}
