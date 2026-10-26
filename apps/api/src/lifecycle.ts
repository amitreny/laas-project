import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Catalog, Lab } from './catalog.js';
import type { LabProvider } from './providers/types.js';
import { ACTIVE_STATES, type EndReason, type InsertResult, type Limits, type SessionRow, type SessionStore } from './sessions.js';

const MINUTE = 60_000;

export interface LifecycleConfig {
  /** End a running lab after this long with no terminal attached. */
  idleMinutes: number;
  /** How much one "extend" adds. */
  extendMinutes: number;
  /** A lab can be extended up to this multiple of its TTL in total. */
  maxLifetimeFactor: number;
  /** Give up on a lab that has been pending this long. */
  pendingTimeoutMinutes: number;
  /** How often the controller loop runs. */
  tickMs: number;
  /** Max active labs per user, and across the whole platform. */
  limits: Limits;
}

const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

export const configFromEnv = (): LifecycleConfig => ({
  idleMinutes: num(process.env.IDLE_MINUTES, 5),
  extendMinutes: num(process.env.EXTEND_MINUTES, 15),
  maxLifetimeFactor: 2,
  pendingTimeoutMinutes: num(process.env.PENDING_TIMEOUT_MINUTES, 5),
  tickMs: num(process.env.TICK_MS, 10_000),
  limits: {
    perUser: num(process.env.MAX_SESSIONS_PER_USER, 1),
    global: num(process.env.MAX_ACTIVE_SESSIONS, 20),
  },
});

/**
 * Owns every session's lifecycle. The database holds the *desired* state; the runtime holds the
 * *actual* state. Request handlers record intent and kick off work, and the controller loop
 * (`tick`) keeps nudging reality towards the database — the same model Kubernetes controllers use.
 */
export class SessionManager extends EventEmitter<{ terminating: [sessionId: string, reason: EndReason] }> {
  // Per-process bookkeeping. Fine while there is one API process; Phase 8 has to revisit it.
  private attachedTerminals = new Map<string, number>();
  private lastTouch = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private store: SessionStore,
    private provider: LabProvider,
    private catalog: Catalog,
    private log: FastifyBaseLogger,
    private config: LifecycleConfig,
  ) {
    super();
  }

  get(id: string) {
    return this.store.get(id);
  }

  listActive(userId?: string) {
    return userId ? this.store.listActiveForUser(userId) : this.store.listByState(...ACTIVE_STATES);
  }

  /** Records the session as pending (if within limits) and provisions it in the background. */
  create(lab: Lab, userId: string): InsertResult {
    const result = this.store.insertWithinLimits(randomUUID(), lab.slug, userId, Date.now(), this.config.limits);
    if ('session' in result) void this.provision(result.session.id, lab);
    return result;
  }

  private async provision(id: string, lab: Lab) {
    try {
      await this.provider.create({
        sessionId: id,
        labSlug: lab.slug,
        image: lab.image,
        workdir: lab.workdir,
        memoryMb: lab.resources.memoryMb,
        cpus: lab.resources.cpus,
        setup: lab.setup,
      });
    } catch (err) {
      this.log.warn({ err, sessionId: id }, 'provisioning failed');
      const failed = this.store.transition(id, 'failed', {
        ended_at: Date.now(),
        end_reason: 'provision_failed',
        error: (err as Error).message,
      });
      if (!failed) this.log.info({ sessionId: id }, 'session already ended, ignoring provisioning failure');
      return;
    }

    const now = Date.now();
    const started = this.store.transition(id, 'running', {
      started_at: now,
      expires_at: now + lab.ttlMinutes * MINUTE,
      last_activity_at: now,
    });
    if (!started) {
      // The session was stopped (or timed out) while we were building it. Nobody wants this container.
      this.log.info({ sessionId: id }, 'session ended during provisioning, removing its container');
      await this.provider.destroy(id).catch((err) => this.log.warn({ err, sessionId: id }, 'cleanup failed'));
    }
  }

  /** Returns false if the session was not active (already ending or ended). */
  async terminate(id: string, reason: EndReason): Promise<boolean> {
    // The first reason wins: if the reaper and the user race, only one of them gets here.
    if (!this.store.transition(id, 'terminating', { end_reason: reason })) return false;
    this.log.info({ sessionId: id, reason }, 'terminating session');
    // Announce before destroying: once the container is gone, attached shells just die with
    // "shell exited" and the user never learns *why*.
    this.emit('terminating', id, reason);
    await this.finishTermination(id);
    return true;
  }

  private async finishTermination(id: string) {
    try {
      await this.provider.destroy(id);
    } catch (err) {
      // Stay in `terminating`; the controller loop will retry.
      this.log.warn({ err, sessionId: id }, 'destroy failed, will retry');
      return;
    }
    if (this.store.transition(id, 'terminated', { ended_at: Date.now() })) {
      this.attachedTerminals.delete(id);
      this.lastTouch.delete(id);
    }
  }

  extend(id: string): SessionRow | undefined {
    const session = this.store.get(id);
    const lab = session && this.catalog.get(session.lab);
    if (!session || session.state !== 'running' || !lab) return undefined;

    const maxExpiry = session.started_at! + lab.ttlMinutes * this.config.maxLifetimeFactor * MINUTE;
    const expiresAt = Math.min(session.expires_at! + this.config.extendMinutes * MINUTE, maxExpiry);
    this.store.setExpiry(id, expiresAt);
    return this.store.get(id);
  }

  // --- activity tracking (feeds the idle reaper) ---------------------------

  terminalAttached(id: string) {
    this.attachedTerminals.set(id, (this.attachedTerminals.get(id) ?? 0) + 1);
    this.store.touch(id, Date.now());
  }

  terminalDetached(id: string) {
    const count = (this.attachedTerminals.get(id) ?? 1) - 1;
    if (count > 0) this.attachedTerminals.set(id, count);
    else this.attachedTerminals.delete(id);
    this.store.touch(id, Date.now());
  }

  /** Called on every keystroke, so it only writes to the database every 30s at most. */
  activity(id: string) {
    const now = Date.now();
    if (now - (this.lastTouch.get(id) ?? 0) < 30_000) return;
    this.lastTouch.set(id, now);
    this.store.touch(id, now);
  }

  // --- the controller loop -------------------------------------------------

  start() {
    // Anything still pending was being provisioned by a previous process, and that work died with it.
    for (const s of this.store.listByState('pending')) {
      this.store.transition(s.id, 'failed', { ended_at: Date.now(), end_reason: 'interrupted' });
    }
    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        this.log.error({ err }, 'controller tick failed');
      }
      // setTimeout after each run (not setInterval) so a slow tick can never overlap the next one.
      this.timer = setTimeout(loop, this.config.tickMs);
    };
    void loop();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async tick() {
    const now = Date.now();

    // 1. Reap: enforce TTLs and idle timeouts.
    for (const s of this.store.listByState('running')) {
      if (s.expires_at! <= now) await this.terminate(s.id, 'expired');
      else if (!this.attachedTerminals.has(s.id) && now - s.last_activity_at > this.config.idleMinutes * MINUTE) {
        await this.terminate(s.id, 'idle');
      }
    }

    // 2. Give up on provisioning that is taking far too long.
    for (const s of this.store.listByState('pending')) {
      if (now - s.created_at > this.config.pendingTimeoutMinutes * MINUTE) {
        this.store.transition(s.id, 'failed', { ended_at: now, end_reason: 'provision_failed', error: 'timed out' });
      }
    }

    // 3. Retry terminations whose destroy failed earlier.
    for (const s of this.store.listByState('terminating')) await this.finishTermination(s.id);

    await this.reconcile();
  }

  /** Compare what the runtime has with what the database says, and fix both directions. */
  private async reconcile() {
    // Read the runtime *before* the database: a container is always created before its session is
    // marked running, so this order can't mistake a brand-new session for a lost one.
    const instances = await this.provider.list();
    const byId = new Map(instances.map((i) => [i.sessionId, i]));

    // Database says running, runtime disagrees → the lab is gone (crashed, OOM-killed, removed by hand).
    for (const s of this.store.listByState('running')) {
      if (!byId.get(s.id)?.running) await this.terminate(s.id, 'container_lost');
    }

    // Runtime has containers the database doesn't want → orphans. Remove them, or they leak forever.
    for (const instance of instances) {
      const s = this.store.get(instance.sessionId);
      if (!s || s.state === 'terminated' || s.state === 'failed') {
        this.log.warn({ sessionId: instance.sessionId }, 'removing orphaned container');
        await this.provider.destroy(instance.sessionId);
      }
    }
  }
}
