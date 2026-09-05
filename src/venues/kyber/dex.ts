/**
 * KyberSwap 聚合器 REST 的类型化封装。两步:
 *   1) GET  /routes       —— 取最优路由摘要(routeSummary)+ router 地址。
 *   2) POST /route/build  —— 用 routeSummary 构造可广播的 swap tx。
 * 金额一律用最小单位字符串(base units),由调用方按 decimals 换算好再传。
 */
import { KYBER_BASE, kyberClientId } from "./config.js";

export interface KyberRouteSummary {
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  /** 预期成交量,tokenOut 的最小单位。 */
  amountOut: string;
  [k: string]: unknown;
}

export interface KyberRoute {
  routeSummary: KyberRouteSummary;
  /** 需要把 fromToken 授权给它的 router(也是 swap tx 的 `to`)。 */
  routerAddress: string;
}

/** 只读报价(含 router 地址),不构造交易。 */
export async function getKyberRoute(p: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
}): Promise<KyberRoute> {
  const qs = new URLSearchParams({
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: p.amountIn,
  });
  const res = await fetch(`${KYBER_BASE}/routes?${qs}`, {
    headers: { "x-client-id": kyberClientId() },
  });
  const json = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { routeSummary?: KyberRouteSummary; routerAddress?: string };
  };
  if (!res.ok || json.code !== 0 || !json.data?.routeSummary || !json.data.routerAddress) {
    throw new Error(
      `Kyber route 无结果(${json.message ?? res.status})——该 token 可能无聚合路由`,
    );
  }
  return { routeSummary: json.data.routeSummary, routerAddress: json.data.routerAddress };
}

export interface KyberBuildTx {
  data: string;
  routerAddress: string;
  /** 原生代币入场时的 msg.value(base units);ERC20 入场为 "0"。 */
  transactionValue: string;
  amountOut: string;
}

/** 构造 swap 交易:返回待签名的 tx(data/routerAddress/transactionValue)。 */
export async function buildKyberTx(p: {
  routeSummary: KyberRouteSummary;
  sender: string;
  recipient: string;
  /** 滑点上限,单位 bip(100 = 1%),直接透传 Kyber 的 slippageTolerance。 */
  slippageBps: number;
}): Promise<KyberBuildTx> {
  const res = await fetch(`${KYBER_BASE}/route/build`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-client-id": kyberClientId() },
    body: JSON.stringify({
      routeSummary: p.routeSummary,
      sender: p.sender,
      recipient: p.recipient,
      slippageTolerance: p.slippageBps,
    }),
  });
  const json = (await res.json()) as {
    code?: number;
    message?: string;
    data?: KyberBuildTx;
  };
  if (!res.ok || json.code !== 0 || !json.data?.data) {
    throw new Error(`Kyber build 失败(${json.message ?? res.status})`);
  }
  return json.data;
}
