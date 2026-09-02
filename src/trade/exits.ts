import type { TradeConfig } from "./config.js";
import { remainingFraction, type Position } from "./positions.js";

export interface ExitAction {
  /** Fraction of the ORIGINAL position to sell now. */
  fraction: number;
  reason: string;
}

/**
 * Decide what (if anything) to sell at the current price.
 * Order of precedence: hard stop > trail stop > stale timeout > take-profits.
 * Stops close the whole remaining position; TPs sell their tier fraction once.
 */
export function evaluateExits(
  position: Position,
  currentPriceUsd: number,
  config: TradeConfig,
  now: Date = new Date(),
): ExitAction[] {
  const remaining = remainingFraction(position);
  if (remaining <= 0 || position.status !== "open") return [];

  const entry = position.entryPriceUsd;
  const highWater = Math.max(position.highWaterUsd, currentPriceUsd);

  if (currentPriceUsd <= entry * (1 - config.hardStopPct)) {
    return [
      {
        fraction: remaining,
        reason: `hard stop: ${(config.hardStopPct * 100).toFixed(0)}% below entry`,
      },
    ];
  }

  if (
    highWater > entry &&
    currentPriceUsd <= highWater * (1 - config.trailStopPct)
  ) {
    return [
      {
        fraction: remaining,
        reason: `trail stop: ${(config.trailStopPct * 100).toFixed(0)}% off high $${highWater.toPrecision(4)}`,
      },
    ];
  }

  const heldHours =
    (now.getTime() - new Date(position.openedAt).getTime()) / 3_600_000;
  if (heldHours >= config.maxHoldHours) {
    return [
      { fraction: remaining, reason: `stale: held ${Math.round(heldHours)}h` },
    ];
  }

  const actions: ExitAction[] = [];
  const multiple = currentPriceUsd / entry;
  for (const tier of config.takeProfits) {
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
