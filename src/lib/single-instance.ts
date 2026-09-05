import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";

/** True if `pid` is a live process this user can see. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = alive but not ours (still alive).
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Machine-global single-instance guard. Returns true if this process acquired
 * the lock, false if another LIVE process already holds it. Prevents duplicate
 * monitors (launchd instance + a stray `npm run monitor`) from double-firing
 * every signal and double-executing live trades.
 *
 * "First live holder wins" — a second starter reads the lock, sees the holder is
 * alive, and should exit(0). A stale lock (holder dead / unreadable) is taken
 * over. The lock is removed on clean exit / SIGINT / SIGTERM.
 */
export function acquireSingleInstanceLock(lockPath: string): boolean {
  const takeStale = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };

  if (existsSync(lockPath)) {
    try {
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (pid && pid !== process.pid && isAlive(pid)) return false;
    } catch {
      /* unreadable → treat as stale */
    }
    takeStale();
  }

  try {
    const fd = openSync(lockPath, "wx"); // exclusive create; fails if it exists
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    // Lost a create race — re-check the current holder.
    try {
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (pid && pid !== process.pid && isAlive(pid)) return false;
    } catch {
      /* fall through to overwrite */
    }
    try {
      const fd = openSync(lockPath, "w");
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch {
      return false;
    }
  }

  const release = (): void => {
    try {
      if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best effort */
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
  return true;
}
