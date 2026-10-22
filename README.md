# LaaS — Labs as a Service

A learning project: an on-demand, browser-accessible lab environment platform.
See [ROADMAP.md](ROADMAP.md) for the phased plan.

## Layout

```
apps/api   Fastify control plane + Docker provider (dockerode)
apps/web   Vite + xterm.js browser terminal
```

## Run (Phase 1)

Prerequisite: Docker Desktop running (`docker run hello-world` works).

```sh
npm install
npm run dev        # api on :3000, web on :5173
```

Open http://localhost:5173, click **Start lab**, and you get a shell in a fresh `ubuntu:24.04` container.
Check `docker ps --filter label=laas.session` to see it from the host.
