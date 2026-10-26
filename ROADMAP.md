# LaaS — Labs as a Service: learning roadmap

Goal: build a small but real "labs as a service" platform (think Instruqt / Killercoda / KodeKloud),
one phase at a time, so that each phase teaches one slice of how these systems work.

## Architecture (where we're heading)

```
 Browser ──HTTP──▶  Control plane (API)  ──▶  Provisioner  ──▶  Runtime (Docker → k8s)
   │                 auth, catalog,            create/destroy      one isolated
   │                 sessions, quotas          reconcile, TTL      environment per session
   └────WebSocket──▶ Access layer ──────────── exec / proxy ──────▶ shell, IDE, web apps
```

The design rule from day one: the API never talks to Docker directly. It talks to a
`LabProvider` interface (`create`, `openShell`, `destroy`). Docker is the first implementation;
Kubernetes is the second (Phase 9). If that swap is painless, the abstraction was right.

---

## Phase 0 — Setup
- Install Docker Desktop (WSL 2 backend), confirm `docker run hello-world`.
- npm workspaces monorepo: `apps/api` (Fastify + dockerode), `apps/web` (Vite + xterm.js).

## Phase 1 — One lab, one user, a terminal in the browser  ✅
**Learn:** Docker Engine API, container lifecycle, `exec` with a TTY, WebSockets, terminal emulation.
- `POST /api/sessions` → pull image if missing, create + start a container labeled `laas.session=<id>`.
- `WS /api/sessions/:id/terminal` → `docker exec bash` with a TTY, piped both ways over a WebSocket.
- `DELETE /api/sessions/:id` → remove the container.
- Basic resource limits (memory, CPU, PIDs).
- Sessions live in memory; Ctrl+C on the API cleans up all containers.

**Done when:** you click Start, type `uname -a` in the browser, click Stop, and `docker ps` is empty.

## Phase 2 — Lab catalog  ✅
**Learn:** declarative definitions, separating *content* from *platform*.
- `labs/<slug>/lab.yaml`: image, resources, TTL, setup script, steps.
- Markdown instructions shown next to the terminal.
- `GET /api/labs`, start a session *of a lab*. Validate definitions with a schema (zod).
- Custom lab images (Dockerfile per lab), built and tagged by a script.

## Phase 3 — Persistence, lifecycle & reconciliation  ✅
**Learn:** state machines, the controller/reconciler pattern (how k8s operators think), crash safety.
- SQLite via Node's built-in `node:sqlite` with plain SQL and versioned migrations.
  Session states: `pending → running → terminating → terminated`, `pending → failed`,
  moved only by compare-and-set updates.
- Async provisioning: `POST` returns `202 pending`, the client polls until `running`.
- TTL + idle timeout; a reaper loop that ends expired sessions; "extend time" button.
- Reconciler: on boot and periodically, diff DB vs `docker ps --filter label=laas.session`
  and fix both directions (orphan containers, ghost sessions).
- Reconnect: refresh the page and get back into the same session.

## Phase 4 — Users, auth & quotas  ✅
**Learn:** authn vs authz, session cookies/JWT, multi-tenancy basics, rate limiting.
- Email + password (scrypt) with a revocable, server-side login token in an HttpOnly cookie.
  Later: OIDC via GitHub/Google, email verification.
- A session belongs to a user; others get 404. Admins (`npm run users:promote`) see everything.
- Quotas: max concurrent labs per user and globally (checked atomically), per-IP rate limits.
- Signed, 30-second HMAC tickets for WebSocket attach; Origin check against CSRF.

## Phase 5 — Isolation & security  ← *we are here*
**Learn:** the threat model of running untrusted users' code — the core risk of any LaaS.
- Hardening: all but 7 capabilities dropped, `no-new-privileges`, seccomp kept on, no swap,
  per-lab non-root `user:`. (Read-only rootfs is used for the egress proxy; it doesn't suit labs,
  where changing the filesystem is the point.)
- Network: no network by default; `network: egress` labs get a private internal network whose only
  exit is a per-lab allow-listing proxy. Host, metadata IPs and other labs are unreachable.
- Disk budgets enforced by the controller loop.
- `npm run security:probe` attacks every lab and compares with an unhardened control.
- Stronger sandboxes compared in `SECURITY.md` (gVisor, Kata, Firecracker, Sysbox).
- `SECURITY.md`: what an attacker inside a lab can and cannot do, and why.

## Phase 6 — Challenges & validation
**Learn:** how lab platforms grade work.
- Each step has a `check` script run inside the container via exec (exit code 0 = pass).
- Progress tracking, hints, completion. Optional: solve scripts for automated lab testing in CI.

## Phase 7 — Richer access: web apps & IDE
**Learn:** reverse proxies, dynamic routing, TLS.
- Expose ports from inside a lab at `https://<session>-<port>.labs.localhost` via Traefik (or a
  custom proxy) with per-session routing + auth.
- Browser IDE (code-server) as an optional lab "tab".
- Multi-container labs (e.g. app + database) via a per-session network.

## Phase 8 — Scale-out & fast starts
**Learn:** job queues, worker processes, capacity planning, warm pools.
- Split provisioner into a worker; API enqueues jobs (BullMQ + Redis).
- Warm pool: pre-created containers so "Start" takes < 1s. Measure p50/p95 start latency.
- Multiple Docker hosts; simple scheduler (least-loaded).

## Phase 9 — Kubernetes provider
**Learn:** Pods, Namespaces, NetworkPolicy, ResourceQuota, RBAC, the k8s API from code.
- `KubernetesProvider implements LabProvider` against a local `kind` cluster.
- Namespace per session, NetworkPolicy deny-by-default, ResourceQuota, exec via the k8s API.

## Phase 10 — Observability & operations
**Learn:** logs, metrics, traces, alerting, audit.
- Structured logs with session/user ids; Prometheus metrics (active sessions, start latency,
  failures, capacity); Grafana dashboard; OpenTelemetry traces across API → worker → runtime.
- Audit log of who started what; admin view to list/kill sessions.

## Phase 11 — Product features
**Learn:** the business side of a LaaS.
- Orgs / classrooms / instructor view of students' progress.
- Metering (lab-minutes per user/org), usage limits, billing hooks.
- Lab authoring workflow: lint + test labs in CI.

## Phase 12 — Deploy it for real
**Learn:** IaC, CI/CD, secrets, cost control.
- Terraform for a cloud environment (VMs or managed k8s), GitHub Actions pipeline,
  TLS + wildcard DNS, secrets management, cost alarms and auto-cleanup.
