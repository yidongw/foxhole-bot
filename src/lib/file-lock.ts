import { mkdir, rm, stat } from "node:fs/promises";

/**
 * Advisory cross-process file lock via atomic mkdir. Guards the shared JSON
 * ledgers (positions.json, review-denylist.json) against lost-update races:
 * 2026-09-04 the engine's slow manage tick and one-shot CLI writers clobbered
 * each other's saves three times in one day — a $60 MarsCoin buy vanished, a
 * denylisted honeypot position resurrected with its exit erased, and denylist
 * entries were rolled back.
 *
 * Semantics: wait up to `waitMs` polling every 100ms; a lock dir older than
 * `staleMs` is broken (crashed holder). On timeout we PROCEED WITHOUT the lock
 * with a loud log — a stuck lock must never freeze stops or block an exit.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; staleMs?: number } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + waitMs;
  let held = false;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      held = true;
      break;
    } catch {
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!held) {
    console.error(
      `file lock timeout on ${lockPath} — proceeding WITHOUT lock (check for a stuck writer)`,
    );
  }
  try {
    return await fn();
  } finally {
    if (held) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
