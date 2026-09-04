/**
 * LI.FI 聚合器接入配置。
 *
 * LI.FI 是 meta 聚合器,已支持 Robinhood Chain(chainId 4663),并聚合 RB 上
 * 多个 DEX(实测路由经 Nordstern / Fly / KyberSwap 等,覆盖 Uniswap v4)。
 * 相比 OKX(RB 执行 revert)与 hoodchain(只认 v3),LI.FI 真能执行且覆盖 v4
 * ——实测 hoodchain 路由不到的 v4 币,LI.FI 接住 10/12。用作首选路由。
 *
 * 公开 REST,无需签名、域名不被本机 DNS 屏蔽(li.quest 正常解析)。可选配
 * LIFI_API_KEY 提高限额;LIFI_INTEGRATOR 是集成方标识(默认 foxhole-bot)。
 */
export const LIFI_BASE = "https://li.quest/v1";
export const LIFI_RB_CHAIN_ID = 4663;

export function lifiApiKey(): string | undefined {
  return process.env.LIFI_API_KEY || undefined;
}

export function lifiIntegrator(): string {
  return process.env.LIFI_INTEGRATOR || "foxhole-bot";
}
