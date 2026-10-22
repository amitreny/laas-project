// Lint the lab catalog without starting the server — the check you'd run in CI on every lab change.
import { loadCatalog } from '../catalog.js';

try {
  const catalog = await loadCatalog();
  for (const lab of catalog.values()) {
    const source = lab.builtLocally ? `built from labs/${lab.slug}/Dockerfile` : 'pulled';
    console.log(`ok  ${lab.slug.padEnd(20)} ${lab.steps.length} steps  ${lab.image} (${source})`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
