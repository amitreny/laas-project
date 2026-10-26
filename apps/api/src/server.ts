import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { registerAuth, requireUser } from './auth/plugin.js';
import { issueTicket } from './auth/tickets.js';
import { UserStore } from './auth/users.js';
import { loadCatalog, toDetail, toSummary } from './catalog.js';
import { openDb } from './db.js';
import { configFromEnv, SessionManager } from './lifecycle.js';
import { DockerProvider } from './providers/docker.js';
import type { LabProvider } from './providers/types.js';
import { SessionStore, toDto } from './sessions.js';
import { registerTerminalRoute } from './terminal.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = Fastify({
  logger: {
    serializers: {
      // Terminal tickets travel in the URL (browsers can't set headers on WebSockets); keep them out of logs.
      req: (req) => ({ method: req.method, url: req.url.replace(/ticket=[^&]+/, 'ticket=REDACTED'), ip: req.ip }),
    },
  },
  // Behind a reverse proxy (Vite in dev, a load balancer in prod), trust X-Forwarded-For from it so
  // req.ip is the real client — otherwise every user shares the proxy's IP and its rate limit.
  trustProxy: process.env.TRUST_PROXY === 'true',
});

// Per-IP limit for every route; individual routes tighten it via `config.rateLimit`.
// The counters live in memory — with several API processes they'd need a shared store (Redis).
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
await app.register(websocket);

// Fail fast: a broken lab definition should stop the deploy, not surprise a user later.
const catalog = await loadCatalog();
app.log.info(`loaded ${catalog.size} lab(s): ${[...catalog.keys()].join(', ')}`);

const db = openDb();
const provider: LabProvider = new DockerProvider();
const manager = new SessionManager(new SessionStore(db), provider, catalog, app.log, configFromEnv());

await registerAuth(app, new UserStore(db));

// --- public ------------------------------------------------------------------

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/labs', async () => [...catalog.values()].map(toSummary));

app.get<{ Params: { slug: string } }>('/api/labs/:slug', async (req, reply) => {
  const lab = catalog.get(req.params.slug);
  if (!lab) return reply.code(404).send({ error: 'lab not found' });
  return toDetail(lab);
});

// --- signed in only ----------------------------------------------------------

// A plugin scope: the preHandler hook below applies only to routes registered inside it.
await app.register(async (authed) => {
  authed.addHook('preHandler', requireUser);

  /**
   * Authorization lives here. A session you don't own looks exactly like one that doesn't exist
   * (404, not 403), so nobody can probe which session ids are real.
   */
  const ownedSession = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const session = manager.get(req.params.id);
    const user = req.user!;
    return session && (session.user_id === user.id || user.role === 'admin') ? session : undefined;
  };

  authed.get<{ Querystring: { all?: string } }>('/api/sessions', async (req) => {
    // Admins can ask for everyone's sessions; everybody else only ever sees their own.
    const everyone = req.query.all === 'true' && req.user!.role === 'admin';
    return manager.listActive(everyone ? undefined : req.user!.id).map(toDto);
  });

  authed.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = ownedSession(req);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return toDto(session);
  });

  authed.post<{ Body: { lab: string } }>(
    '/api/sessions',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: { type: 'object', required: ['lab'], properties: { lab: { type: 'string' } } } },
    },
    async (req, reply) => {
      const lab = catalog.get(req.body.lab);
      if (!lab) return reply.code(404).send({ error: 'lab not found' });

      const result = manager.create(lab, req.user!.id);
      if ('error' in result) {
        if (result.error === 'user_limit') {
          return reply.code(409).send({ error: 'You already have a lab running. Stop it before starting another.' });
        }
        // 503 + Retry-After: "the platform is full, not your fault, try again shortly".
        return reply.code(503).header('retry-after', '60').send({ error: 'All lab slots are in use. Try again in a minute.' });
      }
      // 202 Accepted: the session exists but is still `pending`; the client polls until it's `running`.
      return reply.code(202).send(toDto(result.session));
    },
  );

  authed.post<{ Params: { id: string } }>('/api/sessions/:id/extend', async (req, reply) => {
    if (!ownedSession(req)) return reply.code(404).send({ error: 'session not found' });
    const session = manager.extend(req.params.id);
    if (!session) return reply.code(409).send({ error: 'session is not running' });
    return toDto(session);
  });

  // The browser trades its cookie for a short-lived ticket, then opens the WebSocket with it.
  authed.post<{ Params: { id: string } }>('/api/sessions/:id/ticket', async (req, reply) => {
    const session = ownedSession(req);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (session.state !== 'running') return reply.code(409).send({ error: 'session is not running' });
    return { ticket: issueTicket(session.id, req.user!.id) };
  });

  authed.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    if (!ownedSession(req)) return reply.code(404).send({ error: 'session not found' });
    // Idempotent: stopping a session that has already ended is a success, not an error.
    await manager.terminate(req.params.id, 'user');
    return reply.code(204).send();
  });
});

registerTerminalRoute(app, manager, provider);

// Labs are no longer tied to this process: they keep running across API restarts,
// and the controller loop picks them back up on boot.
const shutdown = async () => {
  manager.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: '127.0.0.1' });
manager.start();
