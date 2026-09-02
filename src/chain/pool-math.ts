const Q96 = 2n ** 96n;
const MIN_TICK = -887272n;
const MAX_TICK = 887272n;

function tickToSqrtRatioX96(tick: bigint): bigint {
  const ratio = Math.pow(1.0001, Number(tick));
  return BigInt(Math.floor(ratio * Number(Q96)));
}

/** Full-range amounts from v3/v4 liquidity + sqrtPrice (matches DexPaprika reserves within ~2%). */
export function amountsForLiquidity(
  liquidity: bigint,
  sqrtPriceX96: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtA = tickToSqrtRatioX96(MIN_TICK);
  const sqrtB = tickToSqrtRatioX96(MAX_TICK);
  const sqrtP = sqrtPriceX96;

  let amount0 = 0n;
  let amount1 = 0n;

  if (sqrtP <= sqrtA) {
    amount0 = (liquidity * Q96 * (sqrtB - sqrtA)) / (sqrtB * sqrtA);
  } else if (sqrtP < sqrtB) {
    amount0 = (liquidity * Q96 * (sqrtB - sqrtP)) / (sqrtB * sqrtP);
    amount1 = (liquidity * (sqrtP - sqrtA)) / Q96;
  } else {
    amount1 = (liquidity * (sqrtB - sqrtA)) / Q96;
  }

  return { amount0, amount1 };
}
