// The seam between the control plane and the runtime. The API only ever talks to this
// interface, so Docker can later be swapped for Kubernetes (or VMs) without touching routes.

/**
 * `none`: loopback only — the lab can't reach anything, and nothing can reach it.
 * `egress`: HTTP(S) out through a filtering proxy, to the listed domains (and their subdomains) only.
 */
export type LabNetwork = { mode: 'none' } | { mode: 'egress'; allow: string[] };

export interface CreateLabOptions {
  sessionId: string;
  labSlug: string;
  image: string;
  /** The user the lab's processes (and the user's shell) run as. */
  user: string;
  workdir: string;
  memoryMb: number;
  cpus: number;
  network: LabNetwork;
  /** Shell script run as root after start; a non-zero exit fails creation. */
  setup?: string;
}

/** A live interactive shell inside a lab, already attached to a TTY. */
export interface Shell {
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface ExecResult {
  exitCode: number;
  /** stdout and stderr, interleaved. */
  output: string;
}

/** What the runtime actually has — the reconciler compares this against the database. */
export interface LabInstance {
  sessionId: string;
  running: boolean;
  /** Bytes written to the lab's own filesystem layer. */
  diskBytes: number;
}

export interface LabProvider {
  create(opts: CreateLabOptions): Promise<void>;
  openShell(sessionId: string): Promise<Shell>;
  /** Runs a script non-interactively inside the lab (as the lab's user unless `user` is given). */
  exec(sessionId: string, script: string, opts?: { user?: string }): Promise<ExecResult>;
  /** Idempotent: destroying something that is already gone succeeds. */
  destroy(sessionId: string): Promise<void>;
  list(): Promise<LabInstance[]>;
}
