/**
 * LI.FI /quote 端点的类型化封装。同链兑换(fromChain === toChain === RB)。
 * 一次 quote 就带回可直接广播的 transactionRequest + 授权地址 + 预期成交量。
 */
import { LIFI_BASE, LIFI_RB_CHAIN_ID, lifiApiKey, lifiIntegrator } from "./config.js";

export interface LifiQuote {
  /** LI.FI 选中的底层工具(DEX/聚合器)名,如 Nordstern Finance / Fly / KyberSwap。 */
  toolName: string;
  /** toToken 精度。 */
  toDecimals: number;
  /** 预期成交的 toToken 数量,最小单位字符串。 */
  toAmount: string;
  /** 要把 fromToken 授权给的地址(LI.FI diamond)。 */
  approvalAddress: string;
  tx: { to: string; data: string; value?: string; gasLimit?: string };
}

export interface LifiQuoteParams {
  fromToken: string;
  toToken: string;
  /** 卖出量,最小单位字符串。 */
  fromAmount: string;
  fromAddress: string;
  /** 十进制小数,如 0.01 = 1%。 */
  slippage: string;
}

/**
 * 取同链兑换报价 + 可广播交易。无路由/接口错误时抛错,交由调用方归入
 * RouteError 触发兜底。
 */
export async function getLifiQuote(p: LifiQuoteParams): Promise<LifiQuote> {
  const qs = new URLSearchParams({
    fromChain: String(LIFI_RB_CHAIN_ID),
    toChain: String(LIFI_RB_CHAIN_ID),
    fromToken: p.fromToken,
    toToken: p.toToken,
    fromAmount: p.fromAmount,
    fromAddress: p.fromAddress,
    slippage: p.slippage,
    integrator: lifiIntegrator(),
  });
  const headers: Record<string, string> = { accept: "application/json" };
  const key = lifiApiKey();
  if (key) headers["x-lifi-api-key"] = key;

  const res = await fetch(`${LIFI_BASE}/quote?${qs}`, { headers });
  const json = (await res.json()) as {
    message?: string;
    tool?: string;
    toolDetails?: { name?: string };
    estimate?: { toAmount?: string; approvalAddress?: string };
    action?: { toToken?: { decimals?: number } };
    transactionRequest?: {
      to?: string;
      data?: string;
      value?: string;
      gasLimit?: string;
    };
  };
  if (!res.ok || !json.transactionRequest || !json.estimate?.toAmount) {
    throw new Error(
      `LI.FI 无报价/路由: ${json.message ?? `HTTP ${res.status}`}`,
    );
  }
  const tx = json.transactionRequest;
  if (!tx.to || !tx.data || !json.estimate.approvalAddress) {
    throw new Error("LI.FI 报价缺少 tx/approvalAddress");
  }
  return {
    toolName: json.toolDetails?.name ?? json.tool ?? "lifi",
    toDecimals: json.action?.toToken?.decimals ?? 18,
    toAmount: json.estimate.toAmount,
    approvalAddress: json.estimate.approvalAddress,
    tx: { to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit },
  };
}
