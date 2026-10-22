import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { loadCatalog, toDetail, toSummary } from './catalog.js';
import { openDb } from './db.js';
import { configFromEnv, SessionManager } from './lifecycle.js';
import { DockerProvider } from './providers/docker.js';
import type { LabProvider } from './providers/types.js';
import { SessionStore, toDto } from './sessions.js';
import { registerTerminalRoute } from './terminal.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: true });
await app.register(websocket);

// Fail fast: a broken lab definition should stop the deploy, not surprise a user later.
const catalog = await loadCatalog();
app.log.info(`loaded ${catalog.size} lab(s): ${[...catalog.keys()].join(', ')}`);

const provider: LabProvider = new DockerProvider();
const manager = new SessionManager(new SessionStore(openDb()), provider, catalog, app.log, configFromEnv());

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/labs', async () => [...catalog.values()].map(toSummary));

app.get<{ Params: { slug: string } }>('/api/labs/:slug', async (req, reply) => {
  const lab = catalog.get(req.params.slug);
  if (!lab) return reply.code(404).send({ error: 'lab not found' });
  return toDetail(lab);
});

app.get('/api/sessions', async () => manager.listActive().map(toDto));

app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
  const session = manager.get(req.params.id);
  if (!session) return reply.code(404).send({ error: 'session not found' });
  return toDto(session);
});

app.post<{ Body: { lab: string } }>(
  '/api/sessions',
  { schema: { body: { type: 'object', required: ['lab'], properties: { lab: { type: 'string' } } } } },
  async (req, reply) => {
    const lab = catalog.get(req.body.lab);
    if (!lab) return reply.code(404).send({ error: 'lab not found' });
    // 202 Accepted: the session exists but is still `pending`; the client polls until it's `running`.
    return reply.code(202).send(toDto(manager.create(lab)));
  },
);

app.post<{ Params: { id: string } }>('/api/sessions/:id/extend', async (req, reply) => {
  const session = manager.extend(req.params.id);
  if (!session) return reply.code(409).send({ error: 'session is not running' });
  return toDto(session);
});

app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
  if (!manager.get(req.params.id)) return reply.code(404).send({ error: 'session not found' });
  // Idempotent: stopping a session that has already ended is a success, not an error.
  await manager.terminate(req.params.id, 'user');
  return reply.code(204).send();
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
