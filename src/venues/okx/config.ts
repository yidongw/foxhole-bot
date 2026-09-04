/**
 * OKX DEX 聚合器接入配置。
 *
 * OKX 已把 Robinhood Chain(chainIndex 4663)纳入其 DEX 聚合器,支持 RB 链
 * meme 的市价/限价单;平台默认 0 抽成(仍付链上 gas + 池子 LP 费 + 滑点)。
 * 我们用它作为 hoodchain 直连路由之外的**可选路由**——聚合多池路由,理论上
 * 能绕开单一池 NoRouteError,并拿到更优价。默认关闭,用 TRADE_ROUTER=okx 开。
 *
 * 所有端点都要 v5 全套鉴权(OK-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE + PROJECT)。
 * 凭证在 OKX Web3 开发者后台申请后写入 .env。
 */

/** OKX Web3 API 主机名(签名/SNI 用真实域名,连接走 DoH 解析出的 IP)。 */
export const OKX_BASE_HOST = "web3.okx.com";

/** Robinhood Chain 在 OKX 聚合器里的 chainIndex。 */
export const OKX_RB_CHAIN_INDEX = "4663";

/**
 * OKX 用这个 sentinel 表示链原生币(RB 链上即 gas 币)。ERC20 交易用不到,
 * 但跨到原生币做多跳路由时可能出现,保留常量以备。
 */
export const OKX_NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface OkxCreds {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  /** Web3 API 特有:开发者后台的 Project ID(OK-ACCESS-PROJECT 头)。 */
  projectId: string;
}

/** 四项凭证齐全才算配好——任一缺失即视为未配置(live 时才需要)。 */
export function okxConfigured(): boolean {
  return Boolean(
    process.env.OKX_API_KEY &&
      process.env.OKX_API_SECRET &&
      process.env.OKX_API_PASSPHRASE &&
      process.env.OKX_PROJECT_ID,
  );
}

/** 读取凭证,缺失即抛——只在 live+router=okx 路径调用,不影响 paper 编译/运行。 */
export function loadOkxCreds(): OkxCreds {
  const apiKey = process.env.OKX_API_KEY;
  const apiSecret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  const projectId = process.env.OKX_PROJECT_ID;
  if (!apiKey || !apiSecret || !passphrase || !projectId) {
    throw new Error(
      "OKX 凭证缺失:需要 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE / OKX_PROJECT_ID",
    );
  }
  return { apiKey, apiSecret, passphrase, projectId };
}
