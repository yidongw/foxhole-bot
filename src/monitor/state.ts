import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SIGNAL_CONFIG } from "../signals/config.js";
import type { AlertLevel } from "../signals/types.js";
import { LEVEL_RANK } from "../signals/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "../../data/monitor-state.json");

export interface TokenSnapshot {
  volume24hUsd: number;
  lockRatio?: number;
  level: AlertLevel;
  score: number;
  updatedAt: string;
}

export interface MonitorState {
  version: 1;
  lastRunAt?: string;
  /** Last factory block scanned for Created events (bigint as string). */
  lastFactoryBlock?: string;
  tokens: Record<string, TokenSnapshot>;
  /** alertKey -> last sent ISO timestamp */
  alertHistory: Record<string, string>;
}

export async function loadMonitorState(): Promise<MonitorState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw) as MonitorState;
  } catch {
    return { version: 1, tokens: {}, alertHistory: {} };
  }
}

export async function saveMonitorState(state: MonitorState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function shouldSendAlert(
  state: MonitorState,
  address: string,
  level: AlertLevel,
  triggers: string[],
): boolean {
  if (level === "none") return false;
  const key = `${address.toLowerCase()}:${level}:${triggers.sort().join(",")}`;
  const last = state.alertHistory[key];
  if (!last) return true;
  const elapsed = Date.now() - new Date(last).getTime();
  return elapsed >= SIGNAL_CONFIG.alertCooldownMs;
}

export function recordAlert(
  state: MonitorState,
  address: string,
  level: AlertLevel,
  triggers: string[],
): void {
  const key = `${address.toLowerCase()}:${level}:${triggers.sort().join(",")}`;
  state.alertHistory[key] = new Date().toISOString();
}

export function isLevelUpgrade(
  prev: AlertLevel | undefined,
  next: AlertLevel,
): boolean {
  if (!prev) return next !== "none";
  return LEVEL_RANK[next] > LEVEL_RANK[prev];
}
