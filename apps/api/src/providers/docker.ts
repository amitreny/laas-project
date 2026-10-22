import Docker from 'dockerode';
import type { CreateLabOptions, LabProvider, Shell } from './types.js';

// Every container we create carries this label, so we can always find "our" containers
// (Phase 3 uses it to reconcile the database against what is actually running).
export const SESSION_LABEL = 'laas.session';

const containerName = (sessionId: string) => `laas-${sessionId}`;

export class DockerProvider implements LabProvider {
  // With no options, dockerode connects to the local engine
  // (named pipe on Windows, /var/run/docker.sock on Linux/macOS).
  private docker = new Docker();

  async create({ sessionId, image }: CreateLabOptions): Promise<void> {
    await this.ensureImage(image);

    const container = await this.docker.createContainer({
      Image: image,
      name: containerName(sessionId),
      Hostname: 'lab',
      // Keep the container alive with no foreground app; users get shells via `exec`.
      Cmd: ['sleep', 'infinity'],
      Labels: { [SESSION_LABEL]: sessionId },
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000, // 1 CPU
        PidsLimit: 256, // stops fork bombs from taking down the host
      },
    });
    await container.start();
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

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // not present locally — pull it
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
    );
  }
}
