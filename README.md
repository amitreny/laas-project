# LaaS — Labs as a Service

A learning project: an on-demand, browser-accessible lab environment platform.
See [ROADMAP.md](ROADMAP.md) for the phased plan.

## Layout

```
apps/api   Fastify control plane, lab catalog loader, Docker provider (dockerode)
apps/web   Vite + xterm.js: lab picker, step instructions, browser terminal
labs/      Lab content: one folder per lab (lab.yaml + steps/*.md + optional Dockerfile)
```

## Run

Prerequisite: Docker Desktop running (`docker run hello-world` works).

```sh
npm install
npm run labs:build   # build images for labs that ship a Dockerfile
npm run dev          # api on :3000, web on :5173
```

Open http://localhost:5173, pick a lab, and follow the steps. The **Run** buttons type commands into the terminal.
Check `docker ps --filter label=laas.session` to see the lab containers from the host.

Sessions are stored in `data/laas.db` (SQLite) and keep running across API restarts. Lifecycle knobs (env vars on the API):

| Variable | Default | Meaning |
|---|---|---|
| `IDLE_MINUTES` | 5 | stop a lab after this long with no terminal attached |
| `EXTEND_MINUTES` | 15 | how much "Extend time" adds (up to 2× the lab's TTL in total) |
| `PENDING_TIMEOUT_MINUTES` | 5 | give up on a lab that hasn't started by then |
| `TICK_MS` | 10000 | how often the controller loop reaps and reconciles |
| `MAX_SESSIONS_PER_USER` | 1 | active labs one user may have |
| `MAX_ACTIVE_SESSIONS` | 20 | active labs across the whole platform |
| `AUTH_SECRET` | random per start | HMAC key for terminal tickets; must be shared by all API processes |
| `TRUST_PROXY` | false | set `true` behind a reverse proxy so rate limits see real client IPs |
| `DB_PATH`, `PORT`, `LABS_DIR` | | where things live |

## Users

Anyone can sign up from the web UI. To make someone an admin (sees and can stop every lab):

```sh
npm run users:promote someone@example.com
```

## Writing a lab

```
labs/<slug>/
  lab.yaml        title, description, image (or a Dockerfile), workdir, resources, setup, steps
  steps/*.md      one Markdown file per step; ```bash blocks get a Run button
  Dockerfile      optional, for labs that need tools baked into the image
```

`npm run labs:validate` checks every lab against the schema in `apps/api/src/catalog.ts`.
