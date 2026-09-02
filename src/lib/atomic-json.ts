import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Atomic JSON persistence: write to a temp file then rename. A crash or
 * SIGKILL mid-write (e.g. launchctl kickstart) can never leave a truncated
 * state file — the old version survives until the rename commits.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, file);
}
