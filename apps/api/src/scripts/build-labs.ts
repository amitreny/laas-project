// Build images for labs that ship their own Dockerfile. Usage: npm run labs:build [slug...]
//
// Building is deliberately separate from running: in a real platform this happens in CI and pushes
// to a registry, so starting a session never waits on `docker build`.
import { spawnSync } from 'node:child_process';
import { loadCatalog } from '../catalog.js';

const only = process.argv.slice(2);
const labs = [...(await loadCatalog()).values()].filter(
  (lab) => lab.builtLocally && (only.length === 0 || only.includes(lab.slug)),
);

if (labs.length === 0) console.log('no labs with a Dockerfile to build');

for (const lab of labs) {
  console.log(`\n==> building ${lab.image} from labs/${lab.slug}`);
  const { status } = spawnSync('docker', ['build', '-t', lab.image, lab.dir], { stdio: 'inherit' });
  if (status !== 0) {
    console.error(`build failed for ${lab.slug}`);
    process.exit(status ?? 1);
  }
}
