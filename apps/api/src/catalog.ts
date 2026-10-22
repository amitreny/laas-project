import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const LABS_DIR = process.env.LABS_DIR ?? fileURLToPath(new URL('../../../labs', import.meta.url));

// Slugs end up in container labels, image tags and URLs, so keep them boring.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The lab.yaml contract. Limits here are *platform policy*: lab authors pick resources,
// but only within what the platform is willing to give a single session.
const LabFileSchema = z.strictObject({
  title: z.string().min(1),
  description: z.string().min(1),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  // Omit `image` to build the lab's own Dockerfile (see `npm run labs:build`).
  image: z.string().min(1).optional(),
  workdir: z.string().startsWith('/').default('/root'),
  resources: z
    .strictObject({
      memoryMb: z.number().int().min(64).max(2048).default(512),
      cpus: z.number().positive().max(2).default(1),
    })
    .default({ memoryMb: 512, cpus: 1 }),
  ttlMinutes: z.number().int().min(5).max(240).default(60), // enforced from Phase 3
  // Runs once inside the container, as root, before the user gets a shell.
  setup: z.string().optional(),
  steps: z.array(z.strictObject({ title: z.string().min(1), file: z.string().min(1) })).min(1),
});

export interface LabStep {
  title: string;
  markdown: string;
}

export interface Lab {
  slug: string;
  dir: string;
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  image: string;
  /** True when the image is built from labs/<slug>/Dockerfile rather than pulled. */
  builtLocally: boolean;
  workdir: string;
  resources: { memoryMb: number; cpus: number };
  ttlMinutes: number;
  setup?: string;
  steps: LabStep[];
}

export type Catalog = Map<string, Lab>;

/** Loads and validates every lab. Throws one error listing *all* problems, so authors can fix them in one pass. */
export async function loadCatalog(labsDir = LABS_DIR): Promise<Catalog> {
  const catalog: Catalog = new Map();
  const errors: string[] = [];

  const entries = await readdir(labsDir, { withFileTypes: true });
  for (const entry of entries.filter((e) => e.isDirectory())) {
    try {
      const lab = await loadLab(path.join(labsDir, entry.name));
      catalog.set(lab.slug, lab);
    } catch (err) {
      errors.push(`labs/${entry.name}: ${(err as Error).message}`);
    }
  }

  if (errors.length) throw new Error(`invalid lab catalog:\n${errors.join('\n')}`);
  return catalog;
}

async function loadLab(dir: string): Promise<Lab> {
  const slug = path.basename(dir);
  if (!SLUG_RE.test(slug)) throw new Error('directory name must be lowercase-kebab-case');

  const result = LabFileSchema.safeParse(parseYaml(await readFile(path.join(dir, 'lab.yaml'), 'utf8')));
  if (!result.success) throw new Error(`lab.yaml\n${z.prettifyError(result.error)}`);
  const def = result.data;

  const hasDockerfile = await exists(path.join(dir, 'Dockerfile'));
  if (def.image && hasDockerfile) throw new Error('set either `image` or a Dockerfile, not both');
  if (!def.image && !hasDockerfile) throw new Error('needs either `image` in lab.yaml or a Dockerfile');

  const steps = await Promise.all(
    def.steps.map(async (step) => {
      const file = path.resolve(dir, step.file);
      // Lab content is data, not code we trust blindly: don't let it read files outside its folder.
      if (!file.startsWith(dir + path.sep)) throw new Error(`step file escapes the lab folder: ${step.file}`);
      return { title: step.title, markdown: await readFile(file, 'utf8') };
    }),
  );

  return {
    slug,
    dir,
    title: def.title,
    description: def.description,
    difficulty: def.difficulty,
    image: def.image ?? `laas-lab/${slug}:latest`,
    builtLocally: !def.image,
    workdir: def.workdir,
    resources: def.resources,
    ttlMinutes: def.ttlMinutes,
    setup: def.setup,
    steps,
  };
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

// What the browser gets to see. Notably *not* `setup`, which often contains the answers.
export const toSummary = (lab: Lab) => ({
  slug: lab.slug,
  title: lab.title,
  description: lab.description,
  difficulty: lab.difficulty,
  ttlMinutes: lab.ttlMinutes,
  stepCount: lab.steps.length,
});

export const toDetail = (lab: Lab) => ({ ...toSummary(lab), steps: lab.steps });
