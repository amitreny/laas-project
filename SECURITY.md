# Security model

A labs platform hands strangers a root shell on purpose. This document describes who we defend
against, what stops them, how each defense is verified, and what is still open.

Run `npm run security:probe` to re-check the defenses against every lab in the catalog. It attacks
each lab from the inside and runs the same attacks from an unhardened control container, so a
"blocked" result can't come from a broken probe.

## Who we defend against

| Attacker | Wants to | Trusted? |
|---|---|---|
| **Lab user** (the main one) | escape the container, attack other labs or the host, use our machines for mining/spam/attacks, take down the platform | No. Assume full control of everything inside their lab, including root there. |
| **Someone on the web** | use other people's labs, guess passwords, trick a logged-in user's browser | No |
| **Lab author** | (mistakes, mostly) ask for too many resources, leak answers, break the page | Partly: lab content is reviewed, but still runs inside the same sandbox, and the UI treats it as untrusted |

## Trust boundaries

```
 browser ──(cookie, ticket)──▶ API ──(Docker socket)──▶ Docker host
                                                         ├─ lab container   ── no network (default)
                                                         └─ lab container ── internal network ── egress proxy ──▶ allow-listed sites
```

The Docker socket is root-equivalent on the host. Only the API holds it; nothing a lab can reach does.

## Defenses

### Containing the lab user

| Threat | Defense | Where | Verified by |
|---|---|---|---|
| Kernel features useful for escapes | All capabilities dropped except 7 (CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID, NET_BIND_SERVICE); Docker's default seccomp syscall filter kept on | `providers/docker.ts` (`LAB_CAPABILITIES`, `HARDENED`) | probe: capability count, mknod, mount, raw sockets, seccomp |
| Becoming root via setuid programs | `no-new-privileges`; labs that don't need root run as a regular user (`user:` in lab.yaml) | `HARDENED`, `catalog.ts` | probe: NoNewPrivs; walkthrough: `su` fails |
| Classic escape settings | Never `--privileged`, never host mounts or the Docker socket, never `seccomp=unconfined`; lab.yaml can't ask for any of it (strict schema) | `providers/docker.ts`, `catalog.ts` | probe: Docker socket check |
| Attacking other labs | No network by default (loopback only). Labs that need the internet each get their own `Internal` network with nothing else on it | `create`, `createEgress` | probe: reach another container |
| Reaching the host or the platform | Same: no route out. Before Phase 5 a lab could call the LaaS API on the host's `127.0.0.1` | as above | probe: reach a host-only service |
| Using us to attack the internet, mine, spam | No direct internet. Egress labs reach only their allow-listed domains, over HTTP(S), through a per-lab proxy; HTTPS tunnels only to port 443 | `infra/egress-proxy/` | probe + walkthrough: allow-listed site works, other sites get 403, bypassing the proxy fails |
| Cloud credential theft (169.254.169.254) | No route to it (same as above) | | probe |
| Fork bombs | 256 processes per lab | `PidsLimit` | probe: pids.max; walkthrough: real fork bomb, neighbour unaffected |
| Memory exhaustion | Hard limit per lab, swap disabled (so the limit is real); the lab's own cgroup kills the hog | `Memory`, `MemorySwap` | probe: allocate more than the limit, lab survives |
| CPU hogging | CPU quota per lab; global cap on active labs | `NanoCpus`, `MAX_ACTIVE_SESSIONS` | — |
| Filling the disk | Per-lab `diskMb`, measured by the controller loop; labs over budget are ended (`disk_limit`) | `lifecycle.ts` | disk test: 200 MB ok, 300 MB ended |
| Exhausting file handles | `nofile` limit of 4096 | `Ulimits` | — |
| Running forever | TTL, idle timeout, reconciler removes anything the database doesn't know about | Phase 3 | lifecycle suite |

### Protecting accounts and sessions (Phase 4)

Passwords hashed with scrypt; login tokens are random, stored hashed and revocable; cookies are
`HttpOnly` and `SameSite=Lax`; cross-origin writes are refused; other users' labs return 404;
terminals need a 30-second signed ticket; per-IP rate limits, tighter on login. Verified by the
Phase 4 security suite.

## Known gaps

Ordered roughly by how much they'd matter in production.

1. **Shared kernel.** Containers (with `runc`) share the host's Linux kernel. One kernel bug and an
   attacker is out. This is the fundamental limit of plain containers. Remedy: a sandboxed runtime
   (below). The provider already accepts one via `LAB_RUNTIME`.
2. **No user namespaces.** Root inside a lab is root on the Docker host once it escapes. Remedy: Docker
   `userns-remap` or rootless Docker, so container root maps to an unprivileged host user.
3. **Disk limits are enforced after the fact.** The controller notices within one tick (10s), so a
   fast writer can overshoot, and a small host disk could fill first. Remedy: real quotas at the
   storage layer (overlay2 on XFS with `pquota`, or a size-limited volume per lab).
4. **Allow-listed domains are trusted completely.** Anything hosted on them is reachable, and data can
   be sent out to them. Keep allow-lists narrow; avoid `github.com`-style "hosts anything" domains.
5. **No bandwidth limits.** An egress lab can download as fast as the proxy allows.
6. **Everything runs on one machine.** The API, its database and the labs share a host. In production,
   labs belong on dedicated, disposable hosts with nothing else on them (Phase 8).
7. **Egress proxies share Docker's default bridge.** They run no user code, but a compromised proxy
   could reach other proxies.
8. **Lab authors are trusted for images.** A lab's Dockerfile could contain anything. It still runs
   inside the same sandbox, but images should come from a reviewed pipeline.

## Stronger sandboxes

| Runtime | How it isolates | Overhead | Compatibility | Typical use |
|---|---|---|---|---|
| **runc + hardening** (now) | Linux namespaces, cgroups, capabilities, seccomp. Shared kernel | None | Everything | Trusted or semi-trusted workloads |
| **gVisor** (`runsc`) | A user-space kernel intercepts syscalls; the host kernel sees very few | Moderate (syscall-heavy and I/O work slows down) | Most Linux software; some syscalls and `/proc` details missing | Untrusted code on shared hosts (Google Cloud Run) |
| **Kata Containers** | Each container in a lightweight VM with its own kernel | VM boot time and memory per lab | Very high | Multi-tenant Kubernetes |
| **Firecracker** | Minimal microVMs (~125 ms boot) | Low for a VM | High, but you build more yourself | AWS Lambda/Fargate; many lab platforms |
| **Sysbox** | runc plus user namespaces and virtualised `/proc`; can run Docker/systemd inside safely | Low | High | Labs that need Docker-in-Docker or systemd |

For a public labs platform, the realistic target is a VM-level boundary (Kata or Firecracker) or
gVisor. They need host support that Docker Desktop doesn't provide, which is why this project
documents them rather than running them.
