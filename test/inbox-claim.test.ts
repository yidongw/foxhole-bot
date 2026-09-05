import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendAiInboxNews,
  archiveAiInbox,
  claimInbox,
  hasClaimableInbox,
  readAiInbox,
} from "../src/notify/ai-inbox.js";
import { getDb, resetDbForTest } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "claim-"));
  process.env.FOXHOLE_DB_PATH = path.join(dir, "foxhole.db");
  process.env.AI_INBOX_JSONL = path.join(dir, "none1.jsonl");
  process.env.AI_INBOX_PROCESSED_JSONL = path.join(dir, "none2.jsonl");
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  delete process.env.FOXHOLE_DB_PATH;
  delete process.env.AI_INBOX_JSONL;
  delete process.env.AI_INBOX_PROCESSED_JSONL;
  rmSync(dir, { recursive: true, force: true });
});

const news = (title: string) =>
  appendAiInboxNews({ title, url: "http://x", reasons: [title], negative: false });

describe("concurrent decider inbox claiming", () => {
  it("shards items across workers (no double-processing) and archives own batch", async () => {
    await news("a");
    await news("b");
    await news("c");

    const batchA = await claimInbox("workerA");
    expect(batchA).toHaveLength(3); // A grabs all currently-unclaimed
    const batchB = await claimInbox("workerB");
    expect(batchB).toHaveLength(0); // B gets nothing — A already claimed them

    // A new item after A's claim goes to B on its next claim.
    await news("d");
    expect(await hasClaimableInbox()).toBe(true);
    const batchB2 = await claimInbox("workerB");
    expect(batchB2.map((s) => (s as { title: string }).title)).toEqual(["d"]);

    // Archiving A's batch leaves B's item active.
    await archiveAiInbox("workerA");
    const active = await readAiInbox();
    expect(active.map((s) => (s as { title: string }).title)).toEqual(["d"]);
  });

  it("reclaims a stale claim (dead worker)", async () => {
    await news("x");
    await claimInbox("deadWorker");
    expect(await claimInbox("liveWorker")).toHaveLength(0); // not stale yet
    // Backdate the claim so it's reclaimable.
    getDb().prepare("UPDATE inbox SET claimed_at=? WHERE claimed_by='deadWorker'").run("2000-01-01T00:00:00.000Z");
    expect(await hasClaimableInbox()).toBe(true);
    const rescued = await claimInbox("liveWorker");
    expect(rescued).toHaveLength(1);
  });
});
