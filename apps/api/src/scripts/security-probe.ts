// Attacks every lab in the catalog from the inside and checks that each attack fails.
// Usage: npm run security:probe   (needs Docker; does not need the API running)
//
// Each attack also runs from an unhardened "control" container. If the control succeeds and the
// lab is blocked, the defense is real; if the control is blocked too, the probe proves nothing —
// that's why the control column exists.
import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { loadCatalog, type Lab } from '../catalog.js';
import { DockerProvider, LAB_CAPABILITIES } from '../providers/docker.js';

interface Attack {
  name: string;
  /** Shell snippet that exits 0 if the attack *succeeded*. */
  script: string;
  /** Run as root even in labs with a regular user: "suppose they already got root inside". */
  asRoot?: boolean;
  /** Whether the control container should be able to do it (false when the host itself blocks it). */
  controlCan: boolean;
}

const tcp = (host: string, port: number | string) => `timeout 3 bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null`;
const capBit = (cap: number) => `[ $(( 0x$(grep CapBnd /proc/self/status | cut -f2) >> ${cap} & 1 )) = 1 ]`;

function attacks(hostPort: number, victimIp: string, hogMb: number): Attack[] {
  return [
    { name: 'reach a service on the host (127.0.0.1)', script: tcp('host.docker.internal', hostPort), controlCan: true },
    { name: "reach another container's web server", script: tcp(victimIp, 80), controlCan: true },
    { name: 'reach the internet directly', script: tcp('example.com', 80), controlCan: true },
    { name: 'reach cloud metadata (169.254.169.254)', script: tcp('169.254.169.254', 80), controlCan: false },
    { name: 'create a device node (mknod)', script: 'mknod /tmp/probe-dev c 1 3', asRoot: true, controlCan: true },
    { name: 'mount a filesystem', script: 'mount -t tmpfs none /mnt', asRoot: true, controlCan: false },
    { name: 'craft raw packets (CAP_NET_RAW)', script: capBit(13), asRoot: true, controlCan: true },
    { name: 'gain privileges via setuid binaries', script: "grep -Eq 'NoNewPrivs:\\s+0' /proc/self/status", controlCan: true },
    { name: 'make syscalls unfiltered (no seccomp)', script: "grep -Eq '^Seccomp:\\s+0' /proc/self/status", controlCan: false },
    { name: 'talk to the Docker daemon', script: 'test -S /var/run/docker.sock', controlCan: false },
    { name: 'fork without limit', script: '[ "$(cat /sys/fs/cgroup/pids.max)" = max ]', controlCan: true },
    { name: 'use swap to exceed memory limit', script: '[ "$(cat /sys/fs/cgroup/memory.swap.max)" != 0 ]', controlCan: true },
    // Actually try it: the lab's own cgroup must kill the hog, not the host's OOM killer.
    { name: `allocate ${hogMb} MB of memory`, script: `head -c ${hogMb}m /dev/zero | tail > /dev/null`, controlCan: true },
  ];
}

function egressAttacks(lab: Lab): Attack[] {
  const viaProxy = (host: string) =>
    `timeout 10 bash -c 'exec 3<>/dev/tcp/egress-proxy/8888; printf "GET http://${host}/ HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n" >&3; head -1 <&3' | grep -Eq " (200|30[0-9]) "`;
  return [
    // The one thing that *should* work, so it's inverted: expect success.
    { name: `fetch an allow-listed site (${lab.egress[0]}) via proxy`, script: viaProxy(lab.egress[0]), controlCan: false },
    { name: 'fetch a non-allow-listed site via proxy', script: viaProxy('example.com'), controlCan: false },
  ];
}

// --- harness -----------------------------------------------------------------

const docker = new Docker();
const provider = new DockerProvider();

async function execIn(container: Docker.Container, script: string, user?: string) {
  const exec = await container.exec({ Cmd: ['bash', '-c', script], User: user, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  const sink = new PassThrough().resume();
  docker.modem.demuxStream(stream, sink, sink);
  await new Promise((resolve) => stream.on('end', resolve));
  return (await exec.inspect()).ExitCode === 0;
}

// A service listening on the host's loopback only — the kind of thing (an admin panel, the LaaS API
// itself) a lab must never reach.
const hostServer = createServer((s) => s.end()).listen(0, '127.0.0.1');
await new Promise((r) => hostServer.once('listening', r));
const hostPort = (hostServer.address() as { port: number }).port;

const probeLabel = { 'laas.probe': 'true' };
const control = await docker.createContainer({ Image: 'ubuntu:24.04', Cmd: ['sleep', 'infinity'], Labels: probeLabel });
const victim = await docker.createContainer({
  Image: 'laas-lab/nginx-intro:latest',
  Cmd: ['sh', '-c', 'nginx && sleep infinity'],
  Labels: probeLabel,
});
const sessions: string[] = [];
let failures = 0;

try {
  await Promise.all([control.start(), victim.start()]);
  const victimIp = Object.values((await victim.inspect()).NetworkSettings.Networks)[0].IPAddress;
  await new Promise((r) => setTimeout(r, 1500)); // let nginx come up

  const catalog = await loadCatalog();
  // A bit more than the most generous lab's memory limit: over every lab's limit, small enough for any host.
  const hogMb = Math.max(...[...catalog.values()].map((l) => l.resources.memoryMb)) + 256;
  const baseAttacks = attacks(hostPort, victimIp, hogMb);
  const controlResults = await Promise.all(baseAttacks.map((a) => execIn(control, a.script, 'root')));
  baseAttacks.forEach((a, i) => {
    if (controlResults[i] !== a.controlCan) {
      failures++;
      console.log(`PROBE BROKEN  control container: "${a.name}" was ${controlResults[i] ? 'possible' : 'blocked'}`);
    }
  });

  for (const lab of catalog.values()) {
    const sessionId = `probe-${randomUUID()}`;
    sessions.push(sessionId);
    await provider.create({
      sessionId,
      labSlug: lab.slug,
      image: lab.image,
      user: lab.user,
      workdir: lab.workdir,
      memoryMb: lab.resources.memoryMb,
      cpus: lab.resources.cpus,
      network: lab.network === 'egress' ? { mode: 'egress', allow: lab.egress } : { mode: 'none' },
      setup: lab.setup,
    });
    const container = docker.getContainer(`laas-${sessionId}`);

    const whoami = (await provider.exec(sessionId, 'id -un')).output.trim();
    console.log(`\n${lab.slug}  (user: ${whoami}, network: ${lab.network})`);

    const capBnd = (await provider.exec(sessionId, 'grep CapBnd /proc/self/status | cut -f2', { user: 'root' })).output;
    const expected = LAB_CAPABILITIES.length;
    const kept = [...BigInt('0x' + capBnd.trim()).toString(2)].filter((b) => b === '1').length;
    const capsOk = kept === expected;
    if (!capsOk) failures++;
    console.log(`  ${capsOk ? 'ok     ' : 'FAIL   '} capability bounding set has ${kept} capabilities (expected ${expected})`);

    const checks = [...baseAttacks, ...(lab.network === 'egress' ? egressAttacks(lab) : [])];
    for (const attack of checks) {
      const succeeded = await execIn(container, attack.script, attack.asRoot ? 'root' : undefined);
      const shouldSucceed = attack.name.startsWith('fetch an allow-listed');
      const ok = succeeded === shouldSucceed;
      if (!ok) failures++;
      const verdict = shouldSucceed ? (succeeded ? 'allowed' : 'BLOCKED') : succeeded ? 'POSSIBLE' : 'blocked';
      console.log(`  ${ok ? 'ok     ' : 'FAIL   '} ${attack.name.padEnd(48)} ${verdict}`);
    }

    // The lab must survive its own attacks (memory hog killed, not the lab).
    const alive = (await container.inspect()).State.Running;
    if (!alive) failures++;
    console.log(`  ${alive ? 'ok     ' : 'FAIL   '} lab still running after the attacks`);
  }
} finally {
  await Promise.all(sessions.map((id) => provider.destroy(id)));
  await Promise.all([control.remove({ force: true }), victim.remove({ force: true })]);
  hostServer.close();
}

console.log(failures === 0 ? '\nAll attacks blocked.' : `\n${failures} problem(s) found.`);
process.exit(failures === 0 ? 0 : 1);
