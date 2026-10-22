import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';

// Must match ClientMessage in apps/api/src/server.ts.
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

const startBtn = document.querySelector<HTMLButtonElement>('#start')!;
const stopBtn = document.querySelector<HTMLButtonElement>('#stop')!;
const statusEl = document.querySelector<HTMLSpanElement>('#status')!;

const term = new Terminal({ cursorBlink: true, fontSize: 14 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.querySelector<HTMLElement>('#terminal')!);
fit.fit();
window.addEventListener('resize', () => fit.fit());

let sessionId: string | null = null;
let socket: WebSocket | null = null;

const setStatus = (text: string) => (statusEl.textContent = text);

const send = (msg: ClientMessage) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
};

term.onData((data) => send({ type: 'input', data }));
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

function connect(id: string) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/api/sessions/${id}/terminal`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    setStatus(`Connected to ${id.slice(0, 8)}`);
    send({ type: 'resize', cols: term.cols, rows: term.rows });
    term.focus();
  };
  socket.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
  socket.onclose = (e) => setStatus(`Disconnected${e.reason ? `: ${e.reason}` : ''}`);
}

startBtn.onclick = async () => {
  startBtn.disabled = true;
  setStatus('Starting lab… (the first run pulls the image, this can take a minute)');
  try {
    const res = await fetch('/api/sessions', { method: 'POST' });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    sessionId = ((await res.json()) as { id: string }).id;
    term.reset();
    connect(sessionId);
    stopBtn.disabled = false;
  } catch (err) {
    setStatus(`Failed to start: ${(err as Error).message}`);
    startBtn.disabled = false;
  }
};

stopBtn.onclick = async () => {
  if (!sessionId) return;
  stopBtn.disabled = true;
  setStatus('Stopping…');
  socket?.close();
  await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  sessionId = null;
  term.reset();
  setStatus('No lab running');
  startBtn.disabled = false;
};
