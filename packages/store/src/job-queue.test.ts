import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MemoryJobQueue } from "./memory-job-queue.js";
import { PgJobQueue } from "./pg/job-queue.js";
import { PgRunStore } from "./pg/postgres-store.js";
import { createMemoryStore, buildEventRecord } from "./memory-store.js";
import { createJobQueue } from "./create-store.js";
import type { JobQueue } from "./job-queue.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("MemoryJobQueue", () => {
  it("enqueues a queued job with defaults", async () => {
    const q = new MemoryJobQueue();
    const job = await q.enqueue({ runId: "r1", kind: "agent" });
    expect(job.status).toBe("queued");
    expect(job.priority).toBe(100);
    expect(job.maxAttempts).toBe(5);
    expect(job.attempts).toBe(0);
  });

  it("enqueue is idempotent per run while a job is active", async () => {
    const q = new MemoryJobQueue();
    const a = await q.enqueue({ runId: "r1", kind: "agent" });
    const b = await q.enqueue({ runId: "r1", kind: "agent" });
    expect(b.id).toBe(a.id);
    expect((await q.countByStatus()).queued).toBe(1);
  });

  it("re-enqueues once the prior job is terminal", async () => {
    const q = new MemoryJobQueue();
    const a = await q.enqueue({ runId: "r1", kind: "agent" });
    const claimed = await q.claim("w1");
    await q.complete(claimed!.id);
    const b = await q.enqueue({ runId: "r1", kind: "resume" });
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe("queued");
  });

  it("claims in priority then availability order", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "low", kind: "agent", priority: 200 });
    await q.enqueue({ runId: "high", kind: "agent", priority: 10 });
    const first = await q.claim("w1");
    expect(first?.runId).toBe("high");
    const second = await q.claim("w1");
    expect(second?.runId).toBe("low");
    expect(await q.claim("w1")).toBeUndefined();
  });

  it("increments attempts and locks on claim", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "r1", kind: "agent" });
    const job = await q.claim("worker-7");
    expect(job?.status).toBe("running");
    expect(job?.attempts).toBe(1);
    expect(job?.lockedBy).toBe("worker-7");
  });

  it("does not claim jobs whose availableAt is in the future", async () => {
    const q = new MemoryJobQueue();
    const future = new Date(Date.now() + 60_000).toISOString();
    await q.enqueue({ runId: "r1", kind: "agent", availableAt: future });
    expect(await q.claim("w1")).toBeUndefined();
  });

  it("requeues with backoff and dead-letters when the budget is exhausted", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "r1", kind: "agent", maxAttempts: 2 });

    const c1 = await q.claim("w1"); // attempts → 1
    await q.fail(c1!.id, { requeue: true, backoffMs: 0, error: "boom" });
    let job = await q.get(c1!.id);
    expect(job?.status).toBe("queued");
    expect(job?.lastError).toBe("boom");

    const c2 = await q.claim("w1"); // attempts → 2 (== max)
    await q.fail(c2!.id, { requeue: true });
    job = await q.get(c2!.id);
    expect(job?.status).toBe("dead");
  });

  it("backoff makes a requeued job briefly unclaimable", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "r1", kind: "agent", maxAttempts: 5 });
    const c = await q.claim("w1");
    await q.fail(c!.id, { requeue: true, backoffMs: 60_000 });
    expect(await q.claim("w1")).toBeUndefined();
  });

  it("fail without requeue marks the job failed (no retry)", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "r1", kind: "agent" });
    const c = await q.claim("w1");
    await q.fail(c!.id, { error: "deliberate" });
    const job = await q.get(c!.id);
    expect(job?.status).toBe("failed");
  });

  it("reaps stale running jobs back to queued", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "r1", kind: "agent", maxAttempts: 5 });
    await q.claim("w1");
    await sleep(5);
    const reaped = await q.reap(0);
    expect(reaped).toBe(1);
    const next = await q.claim("w2");
    expect(next?.status).toBe("running");
    expect(next?.attempts).toBe(2);
  });

  it("reaps a crash-looped job to dead once the budget is gone", async () => {
    const q = new MemoryJobQueue();
    const job = await q.enqueue({ runId: "r1", kind: "agent", maxAttempts: 1 });
    await q.claim("w1"); // attempts → 1 (== max)
    await sleep(5);
    const reaped = await q.reap(0);
    expect(reaped).toBe(1);
    expect((await q.get(job.id))?.status).toBe("dead");
  });

  it("does not reap fresh running jobs", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "r1", kind: "agent" });
    await q.claim("w1");
    expect(await q.reap(60_000)).toBe(0);
  });

  it("counts jobs by status", async () => {
    const q = new MemoryJobQueue();
    await q.enqueue({ runId: "r1", kind: "agent" });
    await q.enqueue({ runId: "r2", kind: "agent" });
    const claimed = await q.claim("w1");
    await q.complete(claimed!.id);
    const counts = await q.countByStatus();
    expect(counts.done).toBe(1);
    expect(counts.queued).toBe(1);
  });

  it("never hands the same job to concurrent claimers", async () => {
    const q = new MemoryJobQueue();
    for (let i = 0; i < 3; i++) await q.enqueue({ runId: `r${i}`, kind: "agent" });
    const claims = await Promise.all([
      q.claim("a"), q.claim("b"), q.claim("c"), q.claim("d"),
    ]);
    const ids = claims.filter((c): c is NonNullable<typeof c> => !!c).map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(claims.filter((c) => c === undefined)).toHaveLength(1);
  });

  it("tail wakes on enqueue", async () => {
    const q = new MemoryJobQueue();
    const ctrl = new AbortController();
    const iter = q.tail(ctrl.signal)[Symbol.asyncIterator]();
    const nextTick = iter.next();
    await q.enqueue({ runId: "r1", kind: "agent" });
    const woke = await Promise.race([
      nextTick.then(() => "woke"),
      sleep(500).then(() => "timeout"),
    ]);
    ctrl.abort();
    await iter.return?.(undefined); // run the generator's cleanup
    expect(woke).toBe("woke");
  });
});

describe("createJobQueue", () => {
  it("yields an in-memory queue for a memory store", () => {
    const q = createJobQueue({ store: createMemoryStore() });
    expect(q).toBeInstanceOf(MemoryJobQueue);
  });

  it("honors an explicit memory type", () => {
    const q = createJobQueue({ type: "memory" });
    expect(q).toBeInstanceOf(MemoryJobQueue);
  });
});

// --- Postgres parity (gated on TEST_DATABASE_URL) ---

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPg = TEST_DATABASE_URL ? describe : describe.skip;

describeWithPg("PgJobQueue parity", () => {
  let store: PgRunStore;
  let q: PgJobQueue;

  const seedRun = async (runId: string): Promise<void> => {
    await store.events.append(
      buildEventRecord(runId, { type: "run.started", input: {} }, { agentName: "wf", spanId: runId }),
    );
  };

  beforeAll(async () => {
    store = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await store.init();
    await store.pool.query("TRUNCATE run_jobs"); // clean slate across CI re-runs
    q = new PgJobQueue(store.pool);
  });

  afterAll(async () => {
    await store.close();
  });

  it("enqueues, claims, and completes", async () => {
    const runId = `job-${randomUUID()}`;
    await seedRun(runId);
    const job = await q.enqueue({ runId, kind: "agent" });
    expect(job.status).toBe("queued");
    const claimed = await claimById(q, job.id);
    expect(claimed.attempts).toBe(1);
    await q.complete(job.id);
    expect((await q.get(job.id))?.status).toBe("done");
  });

  it("enqueue is idempotent per run while active", async () => {
    const runId = `job-${randomUUID()}`;
    await seedRun(runId);
    const a = await q.enqueue({ runId, kind: "agent" });
    const b = await q.enqueue({ runId, kind: "agent" });
    expect(b.id).toBe(a.id);
  });

  it("requeues with backoff then dead-letters when exhausted", async () => {
    const runId = `job-${randomUUID()}`;
    await seedRun(runId);
    const job = await q.enqueue({ runId, kind: "agent", maxAttempts: 2 });

    await claimById(q, job.id); // attempts → 1
    await q.fail(job.id, { requeue: true, backoffMs: 0, error: "boom" });
    expect((await q.get(job.id))?.status).toBe("queued");

    await claimById(q, job.id); // attempts → 2 (== max)
    await q.fail(job.id, { requeue: true });
    expect((await q.get(job.id))?.status).toBe("dead");
  });

  it("reaps stale running jobs back to queued", async () => {
    const runId = `job-${randomUUID()}`;
    await seedRun(runId);
    const job = await q.enqueue({ runId, kind: "agent", maxAttempts: 5 });
    await claimById(q, job.id);
    await sleep(5);
    const reaped = await q.reap(0);
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect((await q.get(job.id))?.status).toBe("queued");
  });

  it("derives a Postgres queue sharing the store pool", () => {
    const q = createJobQueue({ store });
    expect(q).toBeInstanceOf(PgJobQueue);
  });

  it("tail wakes on enqueue", async () => {
    const runId = `job-${randomUUID()}`;
    await seedRun(runId);
    const ctrl = new AbortController();
    const iter = q.tail(ctrl.signal)[Symbol.asyncIterator]();
    const nextTick = iter.next();
    await q.enqueue({ runId, kind: "agent" });
    const woke = await Promise.race([
      nextTick.then(() => "woke"),
      sleep(1000).then(() => "timeout"),
    ]);
    ctrl.abort();
    await iter.return?.(undefined); // release the LISTEN client before pool teardown
    expect(woke).toBe("woke");
  });

  it("never hands the same job to concurrent claimers (SKIP LOCKED)", async () => {
    const runIds = Array.from({ length: 5 }, () => `job-${randomUUID()}`);
    for (const r of runIds) {
      await seedRun(r);
      await q.enqueue({ runId: r, kind: "agent" });
    }
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => q.claim(`w${i}`)),
    );
    const ourClaims = claims
      .filter((c): c is NonNullable<typeof c> => !!c)
      .filter((c) => runIds.includes(c.runId));
    const ids = ourClaims.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
    expect(ourClaims.length).toBe(5);
    for (const c of ourClaims) await q.complete(c.id);
  });
});

/**
 * Claim our specific job (Postgres claims by priority order, not by id). Other
 * tests' leftover queued jobs are completed so they don't block the search.
 */
async function claimById(q: JobQueue, id: string): Promise<NonNullable<Awaited<ReturnType<JobQueue["claim"]>>>> {
  for (let i = 0; i < 50; i++) {
    const c = await q.claim(`probe-${i}`);
    if (!c) break;
    if (c.id === id) return c;
    await q.complete(c.id); // discard unrelated jobs to keep the queue clean
  }
  throw new Error(`claimById: could not claim job ${id}`);
}
