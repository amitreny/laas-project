import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { SessionManager } from './lifecycle.js';
import type { LabProvider, Shell } from './providers/types.js';

// Messages the browser sends over the terminal WebSocket.
// Server → browser is just raw terminal output as binary frames.
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

// Custom close codes (4000–4999 are reserved for applications) tell the browser *why* it was closed.
export const CLOSE_SESSION_ENDED = 4000;
export const CLOSE_NOT_RUNNING = 4409;

export function registerTerminalRoute(app: FastifyInstance, manager: SessionManager, provider: LabProvider) {
  const sockets = new Map<string, Set<WebSocket>>();

  // When a session ends for any reason (user, TTL, idle, lost), kick everyone attached to it.
  manager.on('terminating', (id, reason) => {
    for (const socket of sockets.get(id) ?? []) socket.close(CLOSE_SESSION_ENDED, reason);
    sockets.delete(id);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/terminal', { websocket: true }, async (socket, req) => {
    const { id } = req.params;
    if (manager.get(id)?.state !== 'running') {
      socket.close(CLOSE_NOT_RUNNING, 'session not running');
      return;
    }

    const handle = (shell: Shell, msg: ClientMessage) => {
      if (msg.type === 'input') {
        shell.write(msg.data);
        manager.activity(id);
      } else if (msg.type === 'resize') shell.resize(msg.cols, msg.rows);
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

    if (!sockets.has(id)) sockets.set(id, new Set());
    sockets.get(id)!.add(socket);
    manager.terminalAttached(id);
    socket.on('close', () => {
      sockets.get(id)?.delete(socket);
      manager.terminalDetached(id);
      shell?.close();
    });

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
}
