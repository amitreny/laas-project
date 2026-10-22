import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { loadCatalog, toDetail, toSummary } from './catalog.js';
import { DockerProvider } from './providers/docker.js';
import type { LabProvider, Shell } from './providers/types.js';

const PORT = Number(process.env.PORT ?? 3000);

interface Session {
  id: string;
  lab: string;
  createdAt: string;
}

// Messages the browser sends over the terminal WebSocket.
// Server → browser is just raw terminal output as binary frames.
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

const app = Fastify({ logger: true });
await app.register(websocket);

// Fail fast: a broken lab definition should stop the deploy, not surprise a user later.
const catalog = await loadCatalog();
app.log.info(`loaded ${catalog.size} lab(s): ${[...catalog.keys()].join(', ')}`);

const provider: LabProvider = new DockerProvider();
// Phase 1: in-memory only. Restarting the API forgets sessions (Phase 3 fixes this).
const sessions = new Map<string, Session>();

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/labs', async () => [...catalog.values()].map(toSummary));

app.get<{ Params: { slug: string } }>('/api/labs/:slug', async (req, reply) => {
  const lab = catalog.get(req.params.slug);
  if (!lab) return reply.code(404).send({ error: 'lab not found' });
  return toDetail(lab);
});

app.get('/api/sessions', async () => [...sessions.values()]);

app.post<{ Body: { lab: string } }>(
  '/api/sessions',
  { schema: { body: { type: 'object', required: ['lab'], properties: { lab: { type: 'string' } } } } },
  async (req, reply) => {
    const lab = catalog.get(req.body.lab);
    if (!lab) return reply.code(404).send({ error: 'lab not found' });

    const session: Session = { id: randomUUID(), lab: lab.slug, createdAt: new Date().toISOString() };
    await provider.create({
      sessionId: session.id,
      labSlug: lab.slug,
      image: lab.image,
      workdir: lab.workdir,
      memoryMb: lab.resources.memoryMb,
      cpus: lab.resources.cpus,
      setup: lab.setup,
    });
    sessions.set(session.id, session);
    return reply.code(201).send(session);
  },
);

app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
  const { id } = req.params;
  if (!sessions.has(id)) return reply.code(404).send({ error: 'session not found' });
  await provider.destroy(id);
  sessions.delete(id);
  return reply.code(204).send();
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/terminal', { websocket: true }, async (socket, req) => {
  const { id } = req.params;
  if (!sessions.has(id)) {
    socket.close(4404, 'session not found');
    return;
  }

  const handle = (shell: Shell, msg: ClientMessage) => {
    if (msg.type === 'input') shell.write(msg.data);
    else if (msg.type === 'resize') shell.resize(msg.cols, msg.rows);
  };

  // Listeners must be attached synchronously, before any `await`, or early messages
  // (like the initial resize) are dropped. Buffer them until the shell is ready.
  let shell: Shell | undefined;
  const pending: ClientMessage[] = [];
  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (shell) handle(shell, msg);
    else pending.push(msg);
  });
  socket.on('close', () => shell?.close());

  try {
    shell = await provider.openShell(id);
  } catch (err) {
    req.log.error(err, 'failed to open shell');
    socket.close(1011, 'failed to open shell');
    return;
  }
  if (socket.readyState !== socket.OPEN) {
    shell.close();
    return;
  }
  shell.onData((chunk) => socket.send(chunk));
  shell.onExit(() => socket.close(1000, 'shell exited'));
  for (const msg of pending.splice(0)) handle(shell, msg);
});

// Without persistence, containers would be orphaned on restart — so clean them up on exit.
const shutdown = async () => {
  app.log.info(`shutting down, removing ${sessions.size} lab(s)`);
  await Promise.allSettled([...sessions.keys()].map((id) => provider.destroy(id)));
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: '127.0.0.1' });
