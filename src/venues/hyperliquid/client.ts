/**
 * Hyperliquid **live** 下单执行层。用 agent wallet 私钥做 EIP-712 签名,经
 * @nktkas/hyperliquid 提交到 /exchange。paper 模式完全用不到本文件——
 * 依赖是动态 import 的可选包,不装也不影响 paper 编译与运行。
 *
 * ⚠️ 未经真金验证 —— 先在 testnet (HL_TESTNET=1) 跑通开/平仓再上主网,
 *    与仓库其它 live 路径同样的纪律。
 *
 * HL 没有原生市价单:这里用"激进 IOC 限价单"(买单挂 mark×(1+滑点),
 * 卖单挂 mark×(1−滑点))来模拟市价成交,和官方/CCXT 的做法一致。
 *
 * 若安装的 @nktkas/hyperliquid 版本方法签名有出入,只需改下面三处调用点
 * (ExchangeClient 构造、updateLeverage、order)。
 */

import type { HlConfig } from "./config.js";
import { fetchAssetInfo, resolvePerpDexIndex } from "./info.js";
import type { PerpSide } from "./positions.js";

export interface LiveOpenParams {
  side: PerpSide;
  symbol: string;
  /** 名义敞口 (USD)。 */
  sizeUsd: number;
  leverage: number;
  marginMode: "cross" | "isolated";
  /** 参考价(mid/mark),用来算 size 与激进限价。 */
  referencePriceUsd: number;
  slippageBps: number;
}

export interface LiveFill {
  avgPriceUsd: number;
  sizeCoins: number;
  oid?: number;
}

/** perps 价格精度:5 位有效数字,且小数位不超过 6 - szDecimals。 */
export function roundPx(px: number, szDecimals: number): number {
  if (!(px > 0)) return px;
  const sig = Number(px.toPrecision(5));
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const factor = 10 ** maxDecimals;
  return Math.round(sig * factor) / factor;
}

/** size 取整到 szDecimals。 */
export function roundSz(sz: number, szDecimals: number): number {
  const factor = 10 ** Math.max(0, szDecimals);
  return Math.floor(sz * factor) / factor;
}

// 非字面量 specifier:让 TS 不静态解析这个可选依赖,未安装时也能通过编译。
const NKTKAS_PKG = "@nktkas/hyperliquid";

async function loadSdk(): Promise<any> {
  try {
    return await import(NKTKAS_PKG);
  } catch {
    throw new Error(
      "live 模式需要 @nktkas/hyperliquid,请先安装:npm i @nktkas/hyperliquid@latest",
    );
  }
}

/**
 * HIP-3 asset id 编码(HL 官方 schema):
 *   核心永续          → index_in_meta
 *   builder 部署永续  → 100000 + perp_dex_index * 10000 + index_in_meta
 * perp_dex_index 来自 perpDexs 列表下标(见 info.resolvePerpDexIndex)。
 * 例:testnet 上 test:ABC 的 perp_dex_index=1、index_in_meta=0 → 110000。
 */
export function encodeAssetId(perpDexIndex: number, indexInMeta: number): number {
  return perpDexIndex === 0
    ? indexInMeta
    : 100000 + perpDexIndex * 10000 + indexInMeta;
}

/** 解析某标的在下单/改杠杆时用的 asset id(核心永续即 meta 下标,HIP-3 走编码)。 */
async function resolveAssetId(
  config: HlConfig,
  indexInMeta: number,
): Promise<number> {
  const perpDexIndex = await resolvePerpDexIndex(config.testnet, config.dex || "");
  return encodeAssetId(perpDexIndex, indexInMeta);
}

function buildExchangeClient(hl: any, config: HlConfig): any {
  if (!config.agentKey) {
    throw new Error("缺少 HL_AGENT_KEY(agent wallet 私钥)——live 无法签名");
  }
  const transport = new hl.HttpTransport({ isTestnet: config.testnet });
  // nktkas 接受 hex 私钥字符串或 viem/ethers account 作为 wallet。
  return new hl.ExchangeClient({ wallet: config.agentKey, transport });
}

function parseFill(orderResp: any, fallbackPx: number): LiveFill {
  const statuses =
    orderResp?.response?.data?.statuses ?? orderResp?.data?.statuses ?? [];
  const first = statuses[0] ?? {};
  const filled = first.filled;
  if (filled) {
    return {
      avgPriceUsd: Number(filled.avgPx) || fallbackPx,
      sizeCoins: Number(filled.totalSz) || 0,
      oid: filled.oid,
    };
  }
  const resting = first.resting;
  // IOC 没吃到量(resting 理论上不会出现,但兜底)。
  return { avgPriceUsd: fallbackPx, sizeCoins: 0, oid: resting?.oid };
}

/**
 * 开仓(live)。先设杠杆再下激进 IOC 限价单模拟市价。
 * 返回实际成交均价与币数;成交为 0 时抛错交上层处理。
 */
export async function liveOpenPerp(
  config: HlConfig,
  params: LiveOpenParams,
): Promise<LiveFill> {
  const hl = await loadSdk();
  const asset = await fetchAssetInfo(
    config.testnet,
    params.symbol,
    config.dex || undefined,
  );
  if (!asset) throw new Error(`${params.symbol} 不在可交易宇宙内`);
  const assetId = await resolveAssetId(config, asset.index);

  const client = buildExchangeClient(hl, config);
  const leverage = Math.max(
    1,
    Math.min(Math.floor(params.leverage), asset.maxLeverage),
  );
  await client.updateLeverage({
    asset: assetId,
    isCross: params.marginMode === "cross",
    leverage,
  });

  const isBuy = params.side === "long";
  const slip = params.slippageBps / 10_000;
  const limitPx = roundPx(
    params.referencePriceUsd * (isBuy ? 1 + slip : 1 - slip),
    asset.szDecimals,
  );
  const sizeCoins = roundSz(
    params.sizeUsd / params.referencePriceUsd,
    asset.szDecimals,
  );
  if (!(sizeCoins > 0)) {
    throw new Error(
      `size 取整后为 0(名义 $${params.sizeUsd} / 价 ${params.referencePriceUsd},szDecimals=${asset.szDecimals})`,
    );
  }

  const resp = await client.order({
    orders: [
      {
        a: assetId,
        b: isBuy,
        p: String(limitPx),
        s: String(sizeCoins),
        r: false,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  });
  const fill = parseFill(resp, limitPx);
  if (!(fill.sizeCoins > 0)) {
    throw new Error(`IOC 未成交(滑点不足?)resp: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return fill;
}

export interface LiveCloseParams {
  side: PerpSide;
  symbol: string;
  /** 要平掉的币数。 */
  sizeCoins: number;
  referencePriceUsd: number;
  slippageBps: number;
}

/** 平仓(live):reduce-only 反向 IOC 限价单。 */
export async function liveClosePerp(
  config: HlConfig,
  params: LiveCloseParams,
): Promise<LiveFill> {
  const hl = await loadSdk();
  const asset = await fetchAssetInfo(
    config.testnet,
    params.symbol,
    config.dex || undefined,
  );
  if (!asset) throw new Error(`${params.symbol} 不在可交易宇宙内`);
  const assetId = await resolveAssetId(config, asset.index);

  const client = buildExchangeClient(hl, config);
  // 平多 = 卖出;平空 = 买入。
  const isBuy = params.side === "short";
  const slip = params.slippageBps / 10_000;
  const limitPx = roundPx(
    params.referencePriceUsd * (isBuy ? 1 + slip : 1 - slip),
    asset.szDecimals,
  );
  const sizeCoins = roundSz(params.sizeCoins, asset.szDecimals);
  if (!(sizeCoins > 0)) throw new Error("平仓 size 取整后为 0");

  const resp = await client.order({
    orders: [
      {
        a: assetId,
        b: isBuy,
        p: String(limitPx),
        s: String(sizeCoins),
        r: true,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  });
  return parseFill(resp, limitPx);
}
