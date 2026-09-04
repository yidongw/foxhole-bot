import type { TradeConfig } from "./config.js";
import { remainingFraction, type Position } from "./positions.js";

export interface ExitAction {
  /** Fraction of the ORIGINAL position to sell now. */
  fraction: number;
  reason: string;
}

/**
 * The exit rails actually in force for a position: its own `strategy` overrides
 * wherever set, otherwise the global config default. This is what lets us stop
 * managing every position with one unified plan — each carries its own.
 */
export function effectiveExitParams(position: Position, config: TradeConfig): {
  hardStopPct: number;
  trailStopPct: number;
  trailArmMultiple: number;
  takeProfits: TradeConfig["takeProfits"];
  maxHoldHours: number;
} {
  const s = position.strategy;
  return {
    hardStopPct: s?.hardStopPct ?? config.hardStopPct,
    trailStopPct: s?.trailStopPct ?? config.trailStopPct,
    trailArmMultiple: s?.trailArmMultiple ?? config.trailArmMultiple,
    takeProfits: s?.takeProfits ?? config.takeProfits,
    maxHoldHours: s?.maxHoldHours ?? config.maxHoldHours,
  };
}

/**
 * Decide what (if anything) to sell at the current price.
 * Order of precedence: hard stop > trail stop > stale timeout > take-profits.
 * Stops close the whole remaining position; TPs sell their tier fraction once.
 * Rails come from the position's own strategy where set, else global config.
 */
export function evaluateExits(
  position: Position,
  currentPriceUsd: number,
  config: TradeConfig,
  now: Date = new Date(),
): ExitAction[] {
  const remaining = remainingFraction(position);
  if (remaining <= 0 || position.status !== "open") return [];

  const rails = effectiveExitParams(position, config);
  const entry = position.entryPriceUsd;
  const highWater = Math.max(position.highWaterUsd, currentPriceUsd);

  if (currentPriceUsd <= entry * (1 - rails.hardStopPct)) {
    return [
      {
        fraction: remaining,
        reason: `hard stop: ${(rails.hardStopPct * 100).toFixed(0)}% below entry`,
      },
    ];
  }

  if (
    highWater >= entry * rails.trailArmMultiple &&
    currentPriceUsd <= highWater * (1 - rails.trailStopPct)
  ) {
    return [
      {
        fraction: remaining,
        reason: `trail stop: ${(rails.trailStopPct * 100).toFixed(0)}% off high $${highWater.toPrecision(4)}`,
      },
    ];
  }

  const heldHours =
    (now.getTime() - new Date(position.openedAt).getTime()) / 3_600_000;
  if (heldHours >= rails.maxHoldHours) {
    return [
      { fraction: remaining, reason: `stale: held ${Math.round(heldHours)}h` },
    ];
  }

  const actions: ExitAction[] = [];
  const multiple = currentPriceUsd / entry;
  for (const tier of rails.takeProfits) {
    const alreadyTaken = position.exits.some((e) =>
      e.reason.startsWith(`tp x${tier.atMultiple}`),
    );
    if (multiple >= tier.atMultiple && !alreadyTaken) {
      const fraction = Math.min(tier.sellFraction, remaining);
      if (fraction > 0) {
        actions.push({
          fraction,
          reason: `tp x${tier.atMultiple}: sell ${(tier.sellFraction * 100).toFixed(0)}%`,
        });
      }
    }
  }
  return actions;
}
