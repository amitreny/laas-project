import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { CreateLabOptions, LabProvider, Shell } from './types.js';

// Every container we create carries these labels, so we can always find "our" containers
// (Phase 3 uses them to reconcile the database against what is actually running).
export const SESSION_LABEL = 'laas.session';
export const LAB_LABEL = 'laas.lab';

const containerName = (sessionId: string) => `laas-${sessionId}`;

export class DockerProvider implements LabProvider {
  // With no options, dockerode connects to the local engine
  // (named pipe on Windows, /var/run/docker.sock on Linux/macOS).
  private docker = new Docker();

  async create(opts: CreateLabOptions): Promise<void> {
    await this.ensureImage(opts.image);

    const container = await this.docker.createContainer({
      Image: opts.image,
      name: containerName(opts.sessionId),
      Hostname: 'lab',
      WorkingDir: opts.workdir,
      // Keep the container alive with no foreground app; users get shells via `exec`.
      Cmd: ['sleep', 'infinity'],
      Labels: { [SESSION_LABEL]: opts.sessionId, [LAB_LABEL]: opts.labSlug },
      HostConfig: {
        Memory: opts.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(opts.cpus * 1e9),
        PidsLimit: 256, // stops fork bombs from taking down the host
      },
    });
    await container.start();

    if (opts.setup) {
      const { exitCode, output } = await this.runScript(container, opts.setup);
      if (exitCode !== 0) {
        await this.destroy(opts.sessionId);
        throw new Error(`lab setup failed (exit ${exitCode}):\n${output.slice(-2000)}`);
      }
    }
  }

  async openShell(sessionId: string): Promise<Shell> {
    const container = this.docker.getContainer(containerName(sessionId));
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

  async destroy(sessionId: string): Promise<void> {
    await this.docker.getContainer(containerName(sessionId)).remove({ force: true });
  }

  /** Runs a script non-interactively and waits for it, capturing combined stdout+stderr. */
  private async runScript(container: Docker.Container, script: string) {
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-ec', script],
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
          `If this lab has a Dockerfile, run \`npm run labs:build\`. (${(err as Error).message})`,
      );
    }
  }
}
