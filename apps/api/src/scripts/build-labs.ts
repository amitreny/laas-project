// Build the platform's own images (infra/) and images for labs that ship a Dockerfile.
// Usage: npm run labs:build [slug...]   (no slugs: build everything)
//
// Building is deliberately separate from running: in a real platform this happens in CI and pushes
// to a registry, so starting a session never waits on `docker build`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../catalog.js';
import { EGRESS_IMAGE } from '../providers/docker.js';

const only = process.argv.slice(2);
const builds: { name: string; image: string; dir: string }[] = [];

if (only.length === 0) {
  const dir = fileURLToPath(new URL('../../../../infra/egress-proxy', import.meta.url));
  builds.push({ name: 'egress-proxy', image: EGRESS_IMAGE, dir });
}
for (const lab of (await loadCatalog()).values()) {
  if (lab.builtLocally && (only.length === 0 || only.includes(lab.slug))) {
    builds.push({ name: lab.slug, image: lab.image, dir: lab.dir });
  }
}

if (builds.length === 0) console.log('nothing to build');

for (const { name, image, dir } of builds) {
  console.log(`\n==> building ${image}`);
  const { status } = spawnSync('docker', ['build', '-t', image, dir], { stdio: 'inherit' });
  if (status !== 0) {
    console.error(`build failed for ${name}`);
    process.exit(status ?? 1);
  }
}
