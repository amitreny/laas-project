import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { CreateLabOptions, ExecResult, LabInstance, LabProvider, Shell } from './types.js';

// Everything we create carries these labels, so we can always find "our" resources
// (the reconciler uses them to compare the database against what is actually running).
export const SESSION_LABEL = 'laas.session';
export const LAB_LABEL = 'laas.lab';
const ROLE_LABEL = 'laas.role'; // 'lab' | 'egress'

export const EGRESS_IMAGE = 'laas-infra/egress-proxy:latest';
const EGRESS_ALIAS = 'egress-proxy';
const EGRESS_PORT = 8888;

const labName = (sessionId: string) => `laas-${sessionId}`;
const egressName = (sessionId: string) => `laas-${sessionId}-egress`;
const networkName = (sessionId: string) => `laas-net-${sessionId}`;

// The capabilities a lab's root user keeps. Docker grants 14 by default; these 7 are enough to
// administer *this* container (own files, switch users, bind port 80, kill its own processes) but
// nothing that reaches past it: no raw packets (NET_RAW), device nodes (MKNOD), chroot, or
// capability games (SETPCAP, SETFCAP). A non-root lab user gets none of them at all.
export const LAB_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'];

// Applied to every container we start. Lab authors can't relax any of it. Also note what is
// deliberately absent: `Privileged`, host bind mounts, the Docker socket, `seccomp=unconfined` —
// each one is a well-known container escape. Docker's default seccomp profile stays on.
const HARDENED: Docker.HostConfig = {
  CapDrop: ['ALL'],
  SecurityOpt: ['no-new-privileges:true'], // setuid binaries (sudo, su, ...) can't raise privileges
};

const MB = 1024 * 1024;

export class DockerProvider implements LabProvider {
  // With no options, dockerode connects to the local engine
  // (named pipe on Windows, /var/run/docker.sock on Linux/macOS).
  private docker = new Docker();

  async create(opts: CreateLabOptions): Promise<void> {
    try {
      await this.ensureImage(opts.image);

      let networkMode = 'none';
      let env: string[] = [];
      if (opts.network.mode === 'egress') {
        networkMode = await this.createEgress(opts.sessionId, opts.network.allow);
        const proxy = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;
        // Both spellings: curl and apt read the lowercase ones, many other tools the uppercase ones.
        env = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].map((k) => `${k}=${proxy}`);
        env.push('no_proxy=localhost,127.0.0.1', 'NO_PROXY=localhost,127.0.0.1');
      }

      const container = await this.docker.createContainer({
        Image: opts.image,
        name: labName(opts.sessionId),
        Hostname: 'lab',
        User: opts.user,
        WorkingDir: opts.workdir,
        Env: env,
        // Keep the container alive with no foreground app; users get shells via `exec`.
        Cmd: ['sleep', 'infinity'],
        Labels: { [SESSION_LABEL]: opts.sessionId, [LAB_LABEL]: opts.labSlug, [ROLE_LABEL]: 'lab' },
        HostConfig: {
          ...HARDENED,
          CapAdd: LAB_CAPABILITIES,
          NetworkMode: networkMode,
          Memory: opts.memoryMb * MB,
          MemorySwap: opts.memoryMb * MB, // equal to Memory = no swap, so the limit is real
          NanoCpus: Math.round(opts.cpus * 1e9),
          PidsLimit: 256, // stops fork bombs from taking down the host
          Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
          // Swap runc for a stronger sandbox (e.g. gVisor's `runsc`) where the host has one installed.
          ...(process.env.LAB_RUNTIME ? { Runtime: process.env.LAB_RUNTIME } : {}),
        },
      });
      await container.start();

      if (opts.setup) {
        const { exitCode, output } = await this.exec(opts.sessionId, opts.setup, { user: 'root' });
        if (exitCode !== 0) throw new Error(`lab setup failed (exit ${exitCode}):\n${output.slice(-2000)}`);
      }
    } catch (err) {
      // Don't leave half-built labs (a network, a proxy, a container) behind.
      await this.destroy(opts.sessionId).catch(() => {});
      throw err;
    }
  }

  /**
   * Creates the lab's private network and its egress proxy. The network is `Internal`: it has no
   * gateway, so nothing on it can reach the host, other labs or the internet. The proxy is the
   * one exception — it also sits on Docker's default bridge, and forwards HTTP(S) to allow-listed
   * domains only. One proxy per lab (a "sidecar") keeps each lab's allow-list separate.
   */
  private async createEgress(sessionId: string, allow: string[]): Promise<string> {
    await this.ensureImage(EGRESS_IMAGE);
    const labels = { [SESSION_LABEL]: sessionId, [ROLE_LABEL]: 'egress' };

    const network = await this.docker.createNetwork({
      Name: networkName(sessionId),
      Driver: 'bridge',
      Internal: true,
      Labels: labels,
    });
    const proxy = await this.docker.createContainer({
      Image: EGRESS_IMAGE,
      name: egressName(sessionId),
      Env: [`ALLOW=${allow.join(' ')}`],
      Labels: labels,
      HostConfig: {
        ...HARDENED, // and no capabilities at all: it runs as `nobody` on an unprivileged port
        NetworkMode: 'bridge',
        ReadonlyRootfs: true, // it only needs to write its generated config, to the tmpfs below
        Tmpfs: { '/tmp': 'rw,size=1m' },
        Memory: 64 * MB,
        MemorySwap: 64 * MB,
        NanoCpus: 250_000_000,
        PidsLimit: 64,
      },
    });
    await network.connect({ Container: proxy.id, EndpointConfig: { Aliases: [EGRESS_ALIAS] } });
    await proxy.start();
    return networkName(sessionId);
  }

  async openShell(sessionId: string): Promise<Shell> {
    const container = this.docker.getContainer(labName(sessionId));
    const exec = await container.exec({
      Cmd: ['/bin/bash', '-l'],
      Env: ['TERM=xterm-256color'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true, // with a TTY, stdout/stderr arrive as one raw stream (no multiplexing headers)
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

    return {
      onData: (cb) => stream.on('data', cb),
      onExit: (cb) => stream.on('end', cb),
      write: (data) => stream.write(data),
      resize: (cols, rows) => {
        exec.resize({ w: cols, h: rows }).catch(() => {});
      },
      close: () => stream.end(),
    };
  }

  async exec(sessionId: string, script: string, opts: { user?: string } = {}): Promise<ExecResult> {
    const exec = await this.docker.getContainer(labName(sessionId)).exec({
      Cmd: ['/bin/sh', '-ec', script],
      User: opts.user,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});

    // Without a TTY, Docker multiplexes stdout and stderr into one stream using
    // 8-byte frame headers; demuxStream splits them back apart.
    const chunks: Buffer[] = [];
    const sink = new PassThrough().on('data', (c: Buffer) => chunks.push(c));
    this.docker.modem.demuxStream(stream, sink, sink);
    await new Promise((resolve, reject) => stream.on('end', resolve).on('error', reject));

    const { ExitCode } = await exec.inspect();
    return { exitCode: ExitCode ?? -1, output: Buffer.concat(chunks).toString('utf8') };
  }

  /** Removes everything labeled with this session: lab container, proxy sidecar, network. */
  async destroy(sessionId: string): Promise<void> {
    const filters = { label: [`${SESSION_LABEL}=${sessionId}`] };
    const containers = await this.docker.listContainers({ all: true, filters });
    await Promise.all(containers.map((c) => ignoreGone(this.docker.getContainer(c.Id).remove({ force: true }))));
    // Networks last: Docker refuses to remove a network that still has containers attached.
    const networks = await this.docker.listNetworks({ filters });
    await Promise.all(networks.map((n) => ignoreGone(this.docker.getNetwork(n.Id).remove())));
  }

  async list(): Promise<LabInstance[]> {
    // `size: true` makes Docker compute each container's writable-layer size. It's slower, but this
    // runtime can't cap disk usage up front, so measuring it is how disk limits get enforced.
    const [containers, networks] = await Promise.all([
      this.docker.listContainers({ all: true, size: true, filters: { label: [SESSION_LABEL] } }),
      this.docker.listNetworks({ filters: { label: [SESSION_LABEL] } }),
    ]);

    // One entry per session that has *anything* left, so the reconciler also sees stray
    // proxies and networks (e.g. after a crash mid-provisioning).
    const bySession = new Map<string, LabInstance>();
    const entry = (sessionId: string) => {
      if (!bySession.has(sessionId)) bySession.set(sessionId, { sessionId, running: false, diskBytes: 0 });
      return bySession.get(sessionId)!;
    };
    for (const c of containers) {
      const instance = entry(c.Labels[SESSION_LABEL]);
      if (c.Labels[ROLE_LABEL] !== 'egress') {
        instance.running = c.State === 'running';
        // Docker returns SizeRw when asked for sizes; @types/dockerode just doesn't declare it.
        instance.diskBytes = (c as Docker.ContainerInfo & { SizeRw?: number }).SizeRw ?? 0;
      }
    }
    for (const n of networks) if (n.Labels) entry(n.Labels[SESSION_LABEL]);
    return [...bySession.values()];
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // not present locally — pull it
    }
    try {
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) =>
        this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
      );
    } catch (err) {
      throw new Error(
        `image "${image}" is not available locally and could not be pulled. ` +
          `If it's built from this repo, run \`npm run labs:build\`. (${(err as Error).message})`,
      );
    }
  }
}

/** 404: already gone. 409: removal already in progress. Either way the outcome we want is happening. */
async function ignoreGone(op: Promise<unknown>) {
  try {
    await op;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 404 && status !== 409) throw err;
  }
}
