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

## Writing a lab

```
labs/<slug>/
  lab.yaml        title, description, image (or a Dockerfile), workdir, resources, setup, steps
  steps/*.md      one Markdown file per step; ```bash blocks get a Run button
  Dockerfile      optional, for labs that need tools baked into the image
```

`npm run labs:validate` checks every lab against the schema in `apps/api/src/catalog.ts`.
