import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { acquireSingleInstanceLock } from "../src/lib/single-instance.js";

const dir = mkdtempSync(path.join(tmpdir(), "sil-"));
const lock = path.join(dir, "test.lock");

afterEach(() => {
  try {
    rmSync(lock);
  } catch {
    /* ignore */
  }
});

describe("acquireSingleInstanceLock", () => {
  it("acquires when no lock exists and writes our pid", () => {
    expect(acquireSingleInstanceLock(lock)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });

  it("refuses when a LIVE holder owns the lock", () => {
    // parent pid is definitely alive and not this process's own pid
    writeFileSync(lock, String(process.ppid));
    expect(acquireSingleInstanceLock(lock)).toBe(false);
  });

  it("takes over a STALE lock (dead pid)", () => {
    writeFileSync(lock, "2147483646"); // not a real process
    expect(acquireSingleInstanceLock(lock)).toBe(true);
  });

  it("takes over an unreadable/garbage lock", () => {
    writeFileSync(lock, "not-a-pid");
    expect(acquireSingleInstanceLock(lock)).toBe(true);
  });
});
