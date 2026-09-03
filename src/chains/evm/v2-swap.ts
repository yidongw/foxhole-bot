import {
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  pad,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

import { fetchTokenPriceUsd } from "../../dex/dexscreener.js";
import type { ChainId } from "../adapter.js";
import { getEvmClient } from "./clients.js";

/**
 * UniswapV2-style router execution (PancakeSwap on BSC, Uniswap v2 on ETH).
 * ⚠️ UNTESTED WITH REAL FUNDS — paper-trade first; live requires
 * {BSC,ETH}_PRIVATE_KEY on a throwaway wallet.
 */

export const V2_ROUTERS: Partial<
  Record<
    ChainId,
    {
      router: Address;
      wrappedNative: Address;
      nativeSymbol: string;
      keyVar: string;
      /** Intermediary bases for multi-hop routing (all verified on-chain). */
      bases: Address[];
    }
  >
> = {
  bsc: {
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap v2
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB (verified on-chain: router.WETH())
    nativeSymbol: "BNB",
    keyVar: "BSC_PRIVATE_KEY",
    bases: [
      "0x55d398326f99059fF775485246999027B3197955", // USDT
      "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", // BTCB
    ],
  },
  base: {
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Uniswap v2 (Base)
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH
    nativeSymbol: "ETH",
    keyVar: "BASE_PRIVATE_KEY",
    bases: [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    ],
  },
  ethereum: {
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap v2
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    nativeSymbol: "ETH",
    keyVar: "ETH_PRIVATE_KEY",
    bases: [
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    ],
  },
};

const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const VIEM_CHAINS = { bsc, base, ethereum: mainnet } as const;

function getWallet(chainId: ChainId) {
  const cfg = V2_ROUTERS[chainId];
  if (!cfg) throw new Error(`no v2 router config for ${chainId}`);
  const pk = process.env[cfg.keyVar];
  if (!pk) throw new Error(`${cfg.keyVar} not set — live trading unavailable on ${chainId}`);
  const account = privateKeyToAccount(pk as `0x${string}`);
  const chain = VIEM_CHAINS[chainId as keyof typeof VIEM_CHAINS];
  const transport = http(
    process.env[chainId === "bsc" ? "BSC_RPC" : chainId === "base" ? "BASE_RPC" : "ETH_RPC"] ??
      undefined,
  );
  return { account, wallet: createWalletClient({ account, chain, transport }) };
}

async function nativePriceUsd(chainId: ChainId): Promise<number> {
  const cfg = V2_ROUTERS[chainId]!;
  const price = await fetchTokenPriceUsd(cfg.wrappedNative, chainId);
  if (!price) throw new Error(`no ${cfg.nativeSymbol} price available`);
  return price;
}

export interface V2Fill {
  priceUsd: number;
  amountTokens: number;
  proceedsUsd?: number;
  txHash: `0x${string}`;
}

/** Real tokens received across a buy = post-swap balance minus pre-swap. */
export function tokensReceived(before: bigint, after: bigint): bigint {
  return after > before ? after - before : 0n;
}

/**
 * Real native proceeds from a sell = balance delta plus the gas this swap
 * burned (the raw delta is net of gas, so add it back). Never negative.
 */
export function nativeProceeds(
  before: bigint,
  after: bigint,
  gasCost: bigint,
): bigint {
  const received = after + gasCost - before;
  return received > 0n ? received : 0n;
}

/** Synthetic sender for keyless read-only swap simulation. */
const SIM_SENDER = "0x000000000000000000000000000000000000dEaD" as Address;

export interface RouteQuote {
  path: Address[];
  out: bigint;
}

/**
 * Best v2 route for `amountIn` from → to: tries the direct pair plus one hop
 * through each configured base (USDT/BTCB/USDC), returns the highest-output
 * path. Many four.meme graduates pair against USDT/BTCB rather than WBNB, so
 * the direct [WBNB, token] path reverts — multi-hop recovers them. Returns
 * undefined when no path quotes.
 */
export async function bestRoute(
  chainId: ChainId,
  fromToken: Address,
  toToken: Address,
  amountIn: bigint,
): Promise<RouteQuote | undefined> {
  const cfg = V2_ROUTERS[chainId];
  if (!cfg) return undefined;
  const client: PublicClient = getEvmClient(chainId);
  const from = fromToken.toLowerCase();
  const to = toToken.toLowerCase();
  const candidates: Address[][] = [[fromToken, toToken]];
  for (const base of cfg.bases) {
    const b = base.toLowerCase();
    if (b === from || b === to) continue;
    candidates.push([fromToken, base, toToken]);
  }
  let best: RouteQuote | undefined;
  for (const path of candidates) {
    try {
      const amounts = await client.readContract({
        address: cfg.router,
        abi: ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountIn, path],
      });
      const out = amounts[amounts.length - 1];
      if (out > 0n && (!best || out > best.out)) best = { path, out };
    } catch {
      // no pair for this candidate path — try the next
    }
  }
  return best;
}

export interface V2Preflight {
  ok: boolean;
  reason?: string;
  quotedOut: bigint;
  amountTokens: number;
  priceUsd: number;
  /** The route the swap should use (direct or multi-hop). */
  path?: Address[];
}

/**
 * Keyless, read-only validation of the live BUY path: quote the route and
 * simulate the swap via eth_call with a synthetic funded sender
 * (stateOverride) — no private key, no broadcast, 0 funds. Catches no-route /
 * drained pool / excessive slippage / honeypot-buy-revert before real gas is
 * spent. Used as v2Buy's pre-broadcast gate and standalone for manual checks.
 */
export async function preflightV2Buy(
  chainId: ChainId,
  token: Address,
  usd: number,
  slippageBps: number,
): Promise<V2Preflight> {
  const fail = (reason: string, quotedOut = 0n): V2Preflight => ({
    ok: false,
    reason,
    quotedOut,
    amountTokens: 0,
    priceUsd: 0,
  });
  const cfg = V2_ROUTERS[chainId];
  if (!cfg) return fail(`no v2 router for ${chainId}`);
  const client: PublicClient = getEvmClient(chainId);

  let amountIn: bigint;
  try {
    const native = await nativePriceUsd(chainId);
    amountIn = parseUnits((usd / native).toFixed(18), 18);
  } catch (err) {
    return fail(`native price unavailable: ${(err as Error).message}`);
  }
  const route = await bestRoute(chainId, cfg.wrappedNative, token, amountIn);
  if (!route) return fail("no v2 route (direct + multi-hop all reverted)");
  const { path, out: quotedOut } = route;
  if (quotedOut <= 0n) return fail("zero output quote", quotedOut);

  const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  try {
    await client.simulateContract({
      address: cfg.router,
      abi: ROUTER_ABI,
      functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
      args: [minOut, path, SIM_SENDER, deadline],
      value: amountIn,
      account: SIM_SENDER,
      stateOverride: [{ address: SIM_SENDER, balance: amountIn * 2n }],
    });
  } catch (err) {
    const short =
      (err as { shortMessage?: string }).shortMessage ??
      (err as Error).message.split("\n")[0];
    return fail(`swap would revert: ${short}`, quotedOut);
  }

  let decimals = 18;
  try {
    decimals = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    });
  } catch {
    // default 18; token that graduated will normally implement decimals()
  }
  const amountTokens = Number(formatUnits(quotedOut, decimals));
  return {
    ok: true,
    quotedOut,
    amountTokens,
    priceUsd: amountTokens > 0 ? usd / amountTokens : 0,
    path,
  };
}

// --- Sell-side (round-trip honeypot) preflight ------------------------------
// Simulating a sell needs the synthetic sender to already hold the token and to
// have approved the router. We can't transfer real tokens, so we override the
// ERC20's storage: auto-detect the balanceOf / allowance mapping slots (probe
// standard Solidity layouts) and stateDiff them. Non-standard tokens (Vyper,
// proxies, packed slots) won't be detected → we skip rather than false-block.

const SLOT_PROBE_LIMIT = 25;
const PROBE_VALUE = 10n ** 30n;

/** Storage slot of `mapping(address => _)[holder]` at declaration `slotIndex`. */
function mappingSlot(holder: Address, slotIndex: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, BigInt(slotIndex)],
    ),
  );
}

/** Storage slot of `mapping(owner => mapping(spender => _))[owner][spender]`. */
function allowanceSlot(owner: Address, spender: Address, slotIndex: number): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [owner, BigInt(slotIndex)],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [spender, inner],
    ),
  );
}

/**
 * Per-token cache of detected mapping *declaration indices* (a token property,
 * independent of holder/spender). null = probed and not found (non-standard
 * layout) — cached so we don't re-probe ~50 slots on every buy. The index →
 * slot hash is recomputed per address, so the cache is holder-agnostic.
 */
interface SlotIndices {
  balance: number | null;
  allowance: number | null;
}
const slotIndexCache = new Map<string, SlotIndices>();

/** Test/ops hook: drop cached slot indices. */
export function clearSlotIndexCache(): void {
  slotIndexCache.clear();
}

async function probeBalanceIndex(
  client: PublicClient,
  token: Address,
  holder: Address,
): Promise<number | null> {
  for (let i = 0; i < SLOT_PROBE_LIMIT; i++) {
    try {
      const bal = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
        stateOverride: [
          {
            address: token,
            stateDiff: [{ slot: mappingSlot(holder, i), value: pad(toHex(PROBE_VALUE)) }],
          },
        ],
      });
      if (bal === PROBE_VALUE) return i;
    } catch {
      // reverted for this probe — try next slot index
    }
  }
  return null;
}

async function probeAllowanceIndex(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<number | null> {
  for (let i = 0; i < SLOT_PROBE_LIMIT; i++) {
    try {
      const al = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, spender],
        stateOverride: [
          {
            address: token,
            stateDiff: [
              { slot: allowanceSlot(owner, spender, i), value: pad(toHex(PROBE_VALUE)) },
            ],
          },
        ],
      });
      if (al === PROBE_VALUE) return i;
    } catch {
      // try next slot index
    }
  }
  return null;
}

/** Resolve (and cache) a token's balance + allowance slot declaration indices. */
async function resolveSlotIndices(
  chainId: ChainId,
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<SlotIndices> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const cached = slotIndexCache.get(key);
  if (cached) return cached;
  const [balance, allowance] = await Promise.all([
    probeBalanceIndex(client, token, owner),
    probeAllowanceIndex(client, token, owner, spender),
  ]);
  const indices: SlotIndices = { balance, allowance };
  slotIndexCache.set(key, indices);
  return indices;
}

export interface V2SellPreflight {
  ok: boolean;
  reason?: string;
  /** true = simulated to a real verdict; false = skipped (undetectable slots). */
  simulated: boolean;
  path?: Address[];
}

/**
 * Keyless round-trip honeypot check: can `amountTokens` of `token` actually be
 * SOLD back to native? Fakes the sender's balance + router allowance via
 * storage override and simulates the sell on real chain state (0 funds). This
 * catches "can buy, can't sell" honeypots that a buy-only preflight and (when
 * unavailable) the GoPlus gate would miss. Skips (simulated=false, ok=true)
 * when the token's storage layout can't be introspected — never false-blocks.
 */
export async function preflightV2Sell(
  chainId: ChainId,
  token: Address,
  amountTokens: number,
  slippageBps: number,
): Promise<V2SellPreflight> {
  const cfg = V2_ROUTERS[chainId];
  if (!cfg) return { ok: false, reason: `no v2 router for ${chainId}`, simulated: false };
  const client: PublicClient = getEvmClient(chainId);

  let decimals = 18;
  try {
    decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  } catch {
    // default 18
  }
  const amountIn = parseUnits(amountTokens.toFixed(decimals), decimals);
  if (amountIn <= 0n) return { ok: true, reason: "zero amount", simulated: false };

  const route = await bestRoute(chainId, token, cfg.wrappedNative, amountIn);
  if (!route) return { ok: false, reason: "no v2 sell route", simulated: false };

  const indices = await resolveSlotIndices(
    chainId,
    client,
    token,
    SIM_SENDER,
    cfg.router,
  );
  if (indices.balance == null || indices.allowance == null) {
    return {
      ok: true,
      reason: "sell-sim skipped (non-standard token storage; GoPlus still gates honeypot)",
      simulated: false,
      path: route.path,
    };
  }
  const balSlot = mappingSlot(SIM_SENDER, indices.balance);
  const allowSlot = allowanceSlot(SIM_SENDER, cfg.router, indices.allowance);

  const minOut = (route.out * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const fake = pad(toHex(amountIn * 4n));
  try {
    await client.simulateContract({
      address: cfg.router,
      abi: ROUTER_ABI,
      functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
      args: [amountIn, minOut, route.path, SIM_SENDER, deadline],
      account: SIM_SENDER,
      stateOverride: [
        { address: SIM_SENDER, balance: parseUnits("1", 18) },
        {
          address: token,
          stateDiff: [
            { slot: balSlot, value: fake },
            { slot: allowSlot, value: fake },
          ],
        },
      ],
    });
  } catch (err) {
    const short =
      (err as { shortMessage?: string }).shortMessage ??
      (err as Error).message.split("\n")[0];
    return { ok: false, reason: `sell would revert (honeypot/illiquid): ${short}`, simulated: true, path: route.path };
  }
  return { ok: true, simulated: true, path: route.path };
}

/** Buy `usd` worth of `token` with native currency through the v2 router. */
export async function v2Buy(
  chainId: ChainId,
  token: Address,
  usd: number,
  slippageBps: number,
): Promise<V2Fill> {
  const cfg = V2_ROUTERS[chainId]!;
  const client: PublicClient = getEvmClient(chainId);
  const { account, wallet } = getWallet(chainId);

  // Pre-broadcast gate: validate the whole swap read-only first, so a doomed
  // trade (no route / drained pool / excessive slippage / honeypot) fails
  // without spending gas.
  const pre = await preflightV2Buy(chainId, token, usd, slippageBps);
  if (!pre.ok) {
    throw new Error(
      `v2Buy preflight failed for ${token} on ${chainId}: ${pre.reason}`,
    );
  }

  // Honeypot gate: don't buy what we can't sell. Round-trip simulate the exit
  // (unless disabled). Skips silently for tokens whose storage can't be
  // introspected — GoPlus still covers those.
  if (process.env.TRADE_SELL_PREFLIGHT !== "0") {
    const sellPre = await preflightV2Sell(chainId, token, pre.amountTokens, slippageBps);
    if (!sellPre.ok) {
      throw new Error(
        `v2Buy blocked for ${token} on ${chainId}: fails sell preflight — ${sellPre.reason}`,
      );
    }
  }

  const native = await nativePriceUsd(chainId);
  const amountIn = parseUnits((usd / native).toFixed(18), 18);
  const path = pre.path ?? [cfg.wrappedNative, token];
  const quotedOut = pre.quotedOut;
  const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Measure the real balance delta, not the pre-trade quote: we call the
  // fee-on-transfer swap variant precisely because many BSC memes tax
  // transfers, so tokens actually received are < quotedOut. Recording
  // quotedOut would overstate the position and corrupt P&L + sell sizing.
  const decimals = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const balBefore = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  const hash = await wallet.writeContract({
    address: cfg.router,
    abi: ROUTER_ABI,
    functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    args: [minOut, path, account.address, deadline],
    value: amountIn,
    chain: wallet.chain,
    account,
  });
  await client.waitForTransactionReceipt({ hash });

  const balAfter = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const received = tokensReceived(balBefore, balAfter);
  const amountTokens = Number(formatUnits(received, decimals));
  return {
    priceUsd: amountTokens > 0 ? usd / amountTokens : 0,
    amountTokens,
    txHash: hash,
  };
}

/** Sell `amountTokens` of `token` back to native through the v2 router. */
export async function v2Sell(
  chainId: ChainId,
  token: Address,
  amountTokens: number,
  slippageBps: number,
): Promise<V2Fill> {
  const cfg = V2_ROUTERS[chainId]!;
  const client: PublicClient = getEvmClient(chainId);
  const { account, wallet } = getWallet(chainId);

  const decimals = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const amountIn = parseUnits(amountTokens.toFixed(decimals), decimals);

  // Multi-hop aware: sell back to native directly or via a base (USDT/BTCB),
  // whichever quotes best — four.meme graduates often lack a direct WBNB pair.
  const route = await bestRoute(chainId, token, cfg.wrappedNative, amountIn);
  if (!route) {
    throw new Error(`v2Sell: no v2 route for ${token} on ${chainId}`);
  }
  const { path, out: quotedOut } = route;

  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, cfg.router],
  });
  if (allowance < amountIn) {
    const approveHash = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [cfg.router, amountIn],
      chain: wallet.chain,
      account,
    });
    await client.waitForTransactionReceipt({ hash: approveHash });
  }

  const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Real proceeds = native balance delta + gas spent on this swap (the delta
  // is net of gas). Measured here, after any approve tx, so approval gas is
  // excluded. Beats the pre-trade quote for the same fee-on-transfer reason
  // as the buy side.
  const nativeBefore = await client.getBalance({ address: account.address });
  const hash = await wallet.writeContract({
    address: cfg.router,
    abi: ROUTER_ABI,
    functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    args: [amountIn, minOut, path, account.address, deadline],
    chain: wallet.chain,
    account,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const nativeAfter = await client.getBalance({ address: account.address });
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const proceedsNative = nativeProceeds(nativeBefore, nativeAfter, gasCost);

  const native = await nativePriceUsd(chainId);
  const proceedsUsd = Number(formatUnits(proceedsNative, 18)) * native;
  return {
    priceUsd: amountTokens > 0 ? proceedsUsd / amountTokens : 0,
    amountTokens,
    proceedsUsd,
    txHash: hash,
  };
}
