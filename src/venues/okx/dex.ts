/**
 * OKX DEX 聚合器端点的类型化封装。金额一律用**最小单位字符串**(base units),
 * 由调用方按 token decimals 换算好再传。
 */
import { okxRequest } from "./client.js";

const AGG = "/api/v6/dex/aggregator";

export interface OkxSupportedChain {
  // OKX returns these as JSON numbers; coerce with String() before comparing.
  chainIndex: number | string;
  chainId: number | string;
  chainName: string;
  dexTokenApproveAddress: string;
}

/** 查询聚合器支持的链——用来确认 RB(4663)确实在列。 */
export async function getSupportedChains(): Promise<OkxSupportedChain[]> {
  return okxRequest<OkxSupportedChain[]>(`${AGG}/supported/chain`);
}

export interface OkxTokenInfo {
  tokenContractAddress: string;
  tokenSymbol: string;
  decimal: string;
}

export interface OkxQuote {
  chainIndex: string;
  fromToken: OkxTokenInfo;
  toToken: OkxTokenInfo;
  fromTokenAmount: string;
  toTokenAmount: string;
  tradeFee: string;
  estimateGasFee: string;
}

export interface QuoteParams {
  chainIndex: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  /** 卖出量,最小单位字符串。 */
  amount: string;
}

/** 只读报价(不构造交易),用于 smoke test 与下单前的预期成交量估算。 */
export async function getQuote(p: QuoteParams): Promise<OkxQuote> {
  const data = await okxRequest<OkxQuote[]>(`${AGG}/quote`, { query: { ...p } });
  const q = data[0];
  if (!q) throw new Error("OKX quote 返回空——该 token 可能无聚合路由");
  return q;
}

export interface OkxSwapTx {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  minReceiveAmount?: string;
}

export interface OkxSwapResult {
  routerResult: {
    fromTokenAmount: string;
    toTokenAmount: string;
    fromToken: OkxTokenInfo;
    toToken: OkxTokenInfo;
  };
  tx: OkxSwapTx;
}

export interface SwapParams extends QuoteParams {
  /** 十进制小数,如 0.01 = 1%。 */
  slippage: string;
  userWalletAddress: string;
  /** 默认与 userWalletAddress 相同。 */
  swapReceiverAddress?: string;
}

/** 构造 swap 交易:返回待签名的 tx(to/data/value/gas)与预期成交量。 */
export async function getSwap(p: SwapParams): Promise<OkxSwapResult> {
  const data = await okxRequest<OkxSwapResult[]>(`${AGG}/swap`, {
    query: { ...p },
  });
  const r = data[0];
  if (!r) throw new Error("OKX swap 返回空——无可用路由");
  return r;
}

export interface OkxApproveTx {
  data: string;
  /** 需要授权额度的目标合约(spender / tokenApprove 合约)。 */
  dexContractAddress: string;
  gasLimit: string;
  gasPrice: string;
}

/**
 * 拿到 ERC20 授权交易数据。返回的 `dexContractAddress` 是 spender——即我们要
 * 把 fromToken approve 给它的地址;`data` 是发往 fromToken 合约的 approve calldata。
 */
export async function getApproveTransaction(params: {
  chainIndex: string;
  tokenContractAddress: string;
  /** 授权额度,最小单位字符串。 */
  approveAmount: string;
}): Promise<OkxApproveTx> {
  const data = await okxRequest<OkxApproveTx[]>(`${AGG}/approve-transaction`, {
    query: { ...params },
  });
  const r = data[0];
  if (!r) throw new Error("OKX approve-transaction 返回空");
  return r;
}
