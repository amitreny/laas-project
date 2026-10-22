// The seam between the control plane and the runtime. The API only ever talks to this
// interface, so Docker can later be swapped for Kubernetes (or VMs) without touching routes.

export interface CreateLabOptions {
  sessionId: string;
  image: string;
}

/** A live interactive shell inside a lab, already attached to a TTY. */
export interface Shell {
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface LabProvider {
  create(opts: CreateLabOptions): Promise<void>;
  openShell(sessionId: string): Promise<Shell>;
  destroy(sessionId: string): Promise<void>;
}
