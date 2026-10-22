import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Must match ClientMessage in apps/api/src/server.ts.
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/** An xterm.js terminal wired to a lab session's shell over a WebSocket. */
export class LabTerminal {
  private term = new Terminal({ cursorBlink: true, fontSize: 14 });
  private fitAddon = new FitAddon();
  private socket: WebSocket | null = null;

  constructor(
    el: HTMLElement,
    private events: { onOpen: () => void; onClose: (code: number, reason: string) => void },
  ) {
    this.term.loadAddon(this.fitAddon);
    this.term.open(el);
    this.term.onData((data) => this.send({ type: 'input', data }));
    this.term.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));
    window.addEventListener('resize', () => this.fit());
  }

  /** Call whenever the container becomes visible or changes size; xterm can't measure a hidden element. */
  fit() {
    this.fitAddon.fit();
  }

  connect(sessionId: string) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/api/sessions/${sessionId}/terminal`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.events.onOpen();
      this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
      this.term.focus();
    };
    socket.onmessage = (e) => this.term.write(new Uint8Array(e.data as ArrayBuffer));
    // Only report closes we didn't ask for; disconnect() clears this.socket first.
    socket.onclose = (e) => {
      if (this.socket === socket) this.events.onClose(e.code, e.reason);
    };
    this.socket = socket;
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  reset() {
    this.term.reset();
  }

  /** Type a command into the shell as if the user had, then press Enter. */
  run(command: string) {
    this.send({ type: 'input', data: command.trimEnd().replace(/\n/g, '\r') + '\r' });
    this.term.focus();
  }

  private send(msg: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}
