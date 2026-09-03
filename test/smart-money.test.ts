import { describe, expect, it } from "vitest";

import {
  ConvictionTracker,
  QUOTE_ASSETS,
  TRANSFER_TOPIC0,
  V4_SWAP_TOPIC0,
  addressTopic,
  decodeSwap,
  decodeTransfer,
  detectBuys,
  isQuoteAsset,
  type PoolPair,
  type SwapHit,
  type TransferHit,
} from "../src/chains/robinhood/smart-money.js";
import { qualifyWallet, type ProfitWallet } from "../src/smartmoney/profit.js";
import { parseCieloBuy } from "../src/smartmoney/cielo.js";
import { resolveFilterSync, type SmartMoneyConfig } from "../src/smartmoney/config.js";
import { scoreWallet, type WalletMetrics } from "../src/smartmoney/wallet-quality.js";
import { encodeAbiParameters, parseAbiParameters } from "viem";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // a known quote
const POOL = "0xabc0000000000000000000000000000000000000000000000000000000000001";

const pair: PoolPair = { currency0: TOKEN, currency1: WETH };

function transfer(to: string, token: string, tx: string): TransferHit {
  return { txHash: tx, logIndex: 0, token, from: OTHER, to, value: 1000n };
}
function swap(poolId: string, tx: string, a0 = 1000n, a1 = -5n): SwapHit {
  return { txHash: tx, logIndex: 1, poolId, amount0: a0, amount1: a1 };
}

describe("detectBuys", () => {
  const tracked = new Set([WALLET.toLowerCase()]);
  const pools = new Map([[POOL, pair]]);

  it("flags a buy when a tracked wallet receives a non-quote token in a swap tx", () => {
    const buys = detectBuys(
      [transfer(WALLET, TOKEN, "0xtx1")],
      [swap(POOL, "0xtx1")],
      pools,
      tracked,
    );
    expect(buys).toHaveLength(1);
    expect(buys[0].token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(buys[0].wallet.toLowerCase()).toBe(WALLET.toLowerCase());
    // quote spent = |amount1| for currency1=WETH, 18 decimals
    expect(buys[0].quoteSymbol).toBe("WETH");
  });

  it("ignores a bare transfer with no matching swap (airdrop / CEX withdrawal)", () => {
    const buys = detectBuys(
      [transfer(WALLET, TOKEN, "0xtx2")],
      [],
      pools,
      tracked,
    );
    expect(buys).toHaveLength(0);
  });

  it("ignores swaps in a different tx than the transfer", () => {
    const buys = detectBuys(
      [transfer(WALLET, TOKEN, "0xtxA")],
      [swap(POOL, "0xtxB")],
      pools,
      tracked,
    );
    expect(buys).toHaveLength(0);
  });

  it("ignores buys by untracked wallets", () => {
    const buys = detectBuys(
      [transfer(OTHER, TOKEN, "0xtx3")],
      [swap(POOL, "0xtx3")],
      pools,
      tracked,
    );
    expect(buys).toHaveLength(0);
  });

  it("does not treat a received quote asset as the bought token", () => {
    const buys = detectBuys(
      [transfer(WALLET, WETH, "0xtx4")],
      [swap(POOL, "0xtx4")],
      pools,
      tracked,
    );
    expect(buys).toHaveLength(0);
  });

  it("dedupes multiple transfer legs of the same token in one tx", () => {
    const buys = detectBuys(
      [transfer(WALLET, TOKEN, "0xtx5"), transfer(WALLET, TOKEN, "0xtx5")],
      [swap(POOL, "0xtx5")],
      pools,
      tracked,
    );
    expect(buys).toHaveLength(1);
  });

  it("skips a swap whose pool isn't resolved yet", () => {
    const buys = detectBuys(
      [transfer(WALLET, TOKEN, "0xtx6")],
      [swap("0xUNKNOWNPOOL", "0xtx6")],
      new Map(),
      tracked,
    );
    expect(buys).toHaveLength(0);
  });
});

describe("isQuoteAsset", () => {
  it("recognises known RB quote assets case-insensitively", () => {
    expect(isQuoteAsset(WETH.toUpperCase())).toBe(true);
    expect(isQuoteAsset(TOKEN)).toBe(false);
    expect(Object.keys(QUOTE_ASSETS).length).toBeGreaterThan(0);
  });
});

describe("ConvictionTracker", () => {
  it("counts distinct wallets within the window and expires old buys", () => {
    const t = new ConvictionTracker(60_000);
    expect(t.record(TOKEN, WALLET, 0)).toBe(1);
    expect(t.record(TOKEN, WALLET, 1000)).toBe(1); // same wallet, still 1
    expect(t.record(TOKEN, OTHER, 2000)).toBe(2); // second distinct wallet
    // A fresh buy at 65s; the three early buys (≤2s) are now outside the 60s window
    expect(t.record(TOKEN, WALLET, 65_000)).toBe(1);
    expect(t.distinct(TOKEN, 65_000)).toBe(1);
    // Long after everything has aged out
    expect(t.distinct(TOKEN, 200_000)).toBe(0);
  });
});

describe("qualifyWallet (winner-finder filter)", () => {
  const base: ProfitWallet = {
    address: "0xabc",
    realizedUsd: 50_000,
    sellTx: 5,
    buyTx: 10,
    tags: [],
    source: "gmgn",
  };
  it("accepts a real profitable non-bot wallet", () => {
    expect(qualifyWallet(base)).toBe(true);
  });
  it("rejects contracts, suspicious, and low realized profit", () => {
    expect(qualifyWallet({ ...base, isContract: true })).toBe(false);
    expect(qualifyWallet({ ...base, suspicious: true })).toBe(false);
    expect(qualifyWallet({ ...base, realizedUsd: 100 })).toBe(false);
  });
  it("rejects market-makers/bots and tagged bad actors", () => {
    expect(qualifyWallet({ ...base, buyTx: 4000, sellTx: 4000 })).toBe(false);
    expect(qualifyWallet({ ...base, sellTx: 0 })).toBe(false);
    expect(qualifyWallet({ ...base, tags: ["dex_bot"] })).toBe(false);
    expect(qualifyWallet({ ...base, tags: ["bundler"] })).toBe(false);
    expect(qualifyWallet({ ...base, tags: ["sandwich_bot", "fomo"] })).toBe(false);
  });
});

describe("parseCieloBuy", () => {
  const label = () => "whale";
  it("maps a Cielo tx swap BUY to the acquired token (token1); bnb→bsc", () => {
    const buy = parseCieloBuy(
      {
        type: "tx",
        data: {
          tx_type: "swap",
          is_sell: false,
          wallet: WALLET,
          chain: "bnb",
          tx_hash: "0xhash",
          timestamp: 1700000000,
          token0_symbol: "WBNB",
          token0_amount_usd: 377,
          token1_address: "0xToken1",
          token1_symbol: "TROLL",
          token1_amount_usd: 377,
        },
      },
      label,
    );
    expect(buy?.chain).toBe("bsc"); // bnb → bsc
    expect(buy?.token).toBe("0xToken1");
    expect(buy?.symbol).toBe("TROLL");
    expect(buy?.usd).toBe(377);
    expect(buy?.source).toBe("cielo");
  });

  it("ignores sells (is_sell=true), non-swaps, and missing token1", () => {
    const sell = {
      type: "tx",
      data: { tx_type: "swap", is_sell: true, wallet: WALLET, chain: "bnb", token1_address: "0xWBNB" },
    };
    expect(parseCieloBuy(sell, label)).toBeNull();
    expect(parseCieloBuy({ data: { tx_type: "transfer", wallet: WALLET } }, label)).toBeNull();
    expect(parseCieloBuy({ data: { tx_type: "swap", is_sell: false, wallet: WALLET } }, label)).toBeNull();
  });
});

describe("resolveFilterSync (per-chain / per-wallet filters)", () => {
  const empty: SmartMoneyConfig = { defaults: {}, chains: {}, wallets: {} };
  it("applies built-in chain defaults (RB open, BSC gated)", () => {
    expect(resolveFilterSync(empty, "robinhood", "0x0").alertMinUsd).toBe(0);
    expect(resolveFilterSync(empty, "bsc", "0x0").alertMinUsd).toBe(300);
    expect(resolveFilterSync(empty, "bsc", "0x0").aiMinUsd).toBe(500);
    // RB cools down a wallet re-buying the same token to kill spam.
    expect(resolveFilterSync(empty, "robinhood", "0x0").alertCooldownMin).toBe(30);
    expect(resolveFilterSync(empty, "bsc", "0x0").alertCooldownMin).toBe(0);
  });
  it("wallet override beats chain override beats defaults", () => {
    const cfg: SmartMoneyConfig = {
      defaults: {},
      chains: { bsc: { alertMinUsd: 2000 } },
      wallets: { "0xabc": { alertMinUsd: 9000, soloTrigger: true } },
    };
    expect(resolveFilterSync(cfg, "bsc", "0xZZZ").alertMinUsd).toBe(2000);
    expect(resolveFilterSync(cfg, "bsc", "0xABC").alertMinUsd).toBe(9000);
    expect(resolveFilterSync(cfg, "bsc", "0xABC").soloTrigger).toBe(true);
  });
});

describe("scoreWallet — worth-tracking filter (v2)", () => {
  const good: WalletMetrics = {
    winrate: 0.5,
    tokenNum: 30,
    realizedUsd: 50_000,
    roi: 1.5,
    bigWins: 3,
    losers: 5,
    avgBuyUsd: 2_000,
    medianEntryMcap: 200_000,
    lastActiveDays: 2,
    tags: ["fomo"],
  };
  it("accepts a focused, active, copyable winner", () => {
    const v = scoreWallet(good);
    expect(v.pass).toBe(true);
  });
  it("accepts a modest-winrate HIGH-ROI meme winner (ROI-led)", () => {
    // ≥30% floor + high ROI: skilled and copyable.
    const v = scoreWallet({ ...good, winrate: 0.35, roi: 3.4, realizedUsd: 455_000, tokenNum: 227, bigWins: 2 });
    expect(v.pass).toBe(true);
  });
  it("rejects sub-30% win rate even with high ROI", () => {
    // 0x776b (19% winrate) no longer qualifies under the 30% floor.
    expect(scoreWallet({ ...good, winrate: 0.19, roi: 3.4, realizedUsd: 455_000 }).pass).toBe(false);
  });
  it("rejects the classic false positives", () => {
    // arbitrager bot (the real 牛来 #1 profit wallet)
    expect(scoreWallet({ ...good, tokenNum: 335, tags: ["arbitrager"] }).pass).toBe(false);
    // churn: positive but low ROI (made little per $ spent)
    expect(scoreWallet({ ...good, roi: 0.3 }).pass).toBe(false);
    // win rate below the noise floor
    expect(scoreWallet({ ...good, winrate: 0.05 }).pass).toBe(false);
    // egregious spray (bot-like / un-copyable)
    expect(scoreWallet({ ...good, tokenNum: 500 }).pass).toBe(false);
    // one-hit / churn: never caught a >2x
    expect(scoreWallet({ ...good, bigWins: 0 }).pass).toBe(false);
    // dust trader
    expect(scoreWallet({ ...good, avgBuyUsd: 50 }).pass).toBe(false);
    // dormant
    expect(scoreWallet({ ...good, lastActiveDays: 30 }).pass).toBe(false);
  });
  it("scores ROI over win rate", () => {
    const hiRoi = scoreWallet({ ...good, winrate: 0.3, roi: 4, bigWins: 5 });
    const loRoi = scoreWallet({ ...good, winrate: 0.6, roi: 1.1, bigWins: 1 });
    expect(hiRoi.score).toBeGreaterThan(loRoi.score);
  });
});

describe("log decoding", () => {
  it("decodes an ERC20 Transfer log to a tracked wallet", () => {
    const hit = decodeTransfer({
      address: TOKEN,
      topics: [TRANSFER_TOPIC0, addressTopic(OTHER), addressTopic(WALLET)],
      data: "0x00000000000000000000000000000000000000000000000000000000000003e8",
      blockNumber: 1n,
      transactionHash: "0xdead",
    });
    expect(hit?.to.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(hit?.value).toBe(1000n);
  });

  it("decodes a v4 Swap log", () => {
    const data = encodeAbiParameters(
      parseAbiParameters(
        "int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee",
      ),
      [1000n, -5n, 0n, 0n, 0, 3000],
    );
    const hit = decodeSwap({
      address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      topics: [V4_SWAP_TOPIC0, POOL as `0x${string}`, addressTopic(OTHER)],
      data,
      blockNumber: 1n,
      transactionHash: "0xbeef",
    });
    expect(hit?.poolId).toBe(POOL);
    expect(hit?.amount0).toBe(1000n);
    expect(hit?.amount1).toBe(-5n);
  });
});
